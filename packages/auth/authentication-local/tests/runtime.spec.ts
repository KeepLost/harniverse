import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAuthenticationToken, deleteAuthenticationToken, resetAuthenticationToken } from '../src/management.ts'
import LocalAuthentication, { type Config } from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-runtime-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(
  dshHome: string,
  mode: 'authenticated' | 'bypass' = 'authenticated',
  config: Partial<Config> = {},
): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { ...config, dshHome, mode, watch: false })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

describe('local inbound authentication runtime', () => {
  it('fails authenticated startup before serving when no token exists', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    cleanups.push(() => fiber.dispose())
    await expect(fiber).rejects.toThrow(/at least one token/)
  })

  it('accepts bearer and browser credentials but rejects unauthenticated localhost requests', async () => {
    const dshHome = await home()
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.authenticate({ channel: 'http-api', peerAddress: '127.0.0.1' })).resolves.toEqual({
      kind: 'rejected',
      reason: 'missing-credential',
    })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${token.token}`,
      peerAddress: '127.0.0.1',
    })).resolves.toMatchObject({ kind: 'accepted', credential: { tokenName: 'laptop', generation: 1 } })

    const login = await ctx.authentication.createBrowserSession(token.token, '127.0.0.1')
    expect(login.kind).toBe('accepted')
    if (login.kind !== 'accepted') return
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      cookie: `other=x; dsh_auth=${login.session.value}`,
      peerAddress: '127.0.0.1',
    })).resolves.toMatchObject({ kind: 'accepted', credential: { tokenName: 'laptop' } })
  })

  it('invalidates only sessions issued by the reset or deleted token', async () => {
    const dshHome = await home()
    const laptop = await addAuthenticationToken('laptop', { dshHome })
    const ci = await addAuthenticationToken('ci', { dshHome })
    const ctx = await boot(dshHome)
    const laptopLogin = await ctx.authentication.createBrowserSession(laptop.token)
    const ciLogin = await ctx.authentication.createBrowserSession(ci.token)
    if (laptopLogin.kind !== 'accepted' || ciLogin.kind !== 'accepted') throw new Error('test login failed')

    await resetAuthenticationToken('laptop', { dshHome })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${laptopLogin.session.value}`,
    })).resolves.toMatchObject({ kind: 'rejected' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${ciLogin.session.value}`,
    })).resolves.toMatchObject({ kind: 'accepted', credential: { tokenName: 'ci' } })

    await deleteAuthenticationToken('ci', { dshHome })
    await expect(ctx.authentication.status()).resolves.toEqual({ mode: 'authenticated', sealed: false })
    await deleteAuthenticationToken('laptop', { dshHome })
    await expect(ctx.authentication.status()).resolves.toEqual({ mode: 'authenticated', sealed: true })
    await addAuthenticationToken('replacement', { dshHome })
    await expect(ctx.authentication.status()).resolves.toEqual({ mode: 'authenticated', sealed: false })
  })

  it('bounds browser sessions and evicts the oldest live session', async () => {
    const dshHome = await home()
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = await boot(dshHome, 'authenticated', { maxBrowserSessions: 2 })
    const first = await ctx.authentication.createBrowserSession(token.token)
    const second = await ctx.authentication.createBrowserSession(token.token)
    const third = await ctx.authentication.createBrowserSession(token.token)
    if (first.kind !== 'accepted' || second.kind !== 'accepted' || third.kind !== 'accepted') {
      throw new Error('expected browser logins to succeed')
    }

    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${first.session.value}`,
    })).resolves.toMatchObject({ kind: 'rejected' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${second.session.value}`,
    })).resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${third.session.value}`,
    })).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('prunes expired browser sessions before applying the capacity limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
    const dshHome = await home()
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = await boot(dshHome, 'authenticated', { maxBrowserSessions: 2, sessionTtlMs: 10 })
    const first = await ctx.authentication.createBrowserSession(token.token)
    if (first.kind !== 'accepted') throw new Error('expected browser login to succeed')
    vi.setSystemTime(new Date('2026-08-16T00:00:00.020Z'))

    const second = await ctx.authentication.createBrowserSession(token.token)
    if (second.kind !== 'accepted') throw new Error('expected browser login to succeed')
    expect((ctx.authentication as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1)
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${second.session.value}`,
    })).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('admits without credentials in explicit bypass mode and still owns the instance lease', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome, 'bypass')
    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toEqual({ kind: 'accepted' })

    const contender = new Context().plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    cleanups.push(() => contender.dispose())
    await expect(contender).rejects.toThrow(/already running in bypass mode/)
  })
})
