import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addAuthenticationToken,
  authenticationTokenRegistryPath,
  resetAuthenticationToken,
} from '../src/management.ts'
import LocalAuthentication from '../src/index.ts'

const watchers: FakeWatcher[] = []

class FakeWatcher extends EventEmitter {
  close(): Promise<void> { return Promise.resolve() }
}

vi.mock('chokidar', () => ({
  watch: () => {
    const watcher = new FakeWatcher()
    watchers.push(watcher)
    return watcher
  },
}))

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  watchers.length = 0
})

describe('token registry revocation publication', () => {
  it('publishes only the credential revision removed by a reset', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    await addAuthenticationToken('laptop', { dshHome })
    await addAuthenticationToken('ci', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const seen: string[][] = []
    ctx.on('authentication/revoked', ({ credentials }) => {
      seen.push(credentials.map(credential => credential.tokenName))
    })

    await resetAuthenticationToken('laptop', { dshHome })
    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(seen).toEqual([['laptop']]) })
  })

  it('revokes a used intermediate revision when two resets precede one refresh', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    await addAuthenticationToken('laptop', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const intermediate = await resetAuthenticationToken('laptop', { dshHome })
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux', authorization: `Bearer ${intermediate.token}`,
    })).resolves.toMatchObject({ kind: 'accepted', credential: { generation: 2 } })
    await resetAuthenticationToken('laptop', { dshHome })
    const generations: number[] = []
    ctx.on('authentication/revoked', ({ credentials }) => {
      generations.push(...credentials.map(credential => credential.generation))
    })

    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(generations.sort()).toEqual([1, 2]) })
  })

  it('fails closed on watcher error and recovers after reconciliation', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const login = await ctx.authentication.createBrowserSession(token.token)
    if (login.kind !== 'accepted') throw new Error('expected browser login to succeed')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watchers[0]!.emit('error', new Error('watch unavailable'))
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', cookie: `dsh_auth=${login.session.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(unavailable).toHaveBeenCalledTimes(1)

    watchers[0]!.emit('all', 'change')
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', authorization: `Bearer ${token.token}`,
    })).resolves.toMatchObject({ kind: 'accepted', credential: { generation: 1 } })
  })

  it('reconciles a missed registry event on the fallback interval', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    await addAuthenticationToken('laptop', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, {
      dshHome, mode: 'authenticated', debounceMs: 0, reconcileIntervalMs: 10,
    })
    cleanups.push(() => fiber.dispose())
    await fiber
    const generations: number[] = []
    ctx.on('authentication/revoked', ({ credentials }) => {
      generations.push(...credentials.map(credential => credential.generation))
    })

    await resetAuthenticationToken('laptop', { dshHome })

    await vi.waitFor(() => { expect(generations).toEqual([1]) })
  })

  it('fails closed when reconciliation cannot read the registry and recovers later', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const token = await addAuthenticationToken('laptop', { dshHome })
    const registryPath = authenticationTokenRegistryPath(dshHome)
    const registry = await readFile(registryPath, 'utf8')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const unavailable = vi.fn()
    const available = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    ctx.on('authentication/available', available)

    await writeFile(registryPath, '{invalid json', 'utf8')
    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledTimes(1) })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', authorization: `Bearer ${token.token}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })

    await writeFile(registryPath, registry, 'utf8')
    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(available).toHaveBeenCalledTimes(1) })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', authorization: `Bearer ${token.token}`,
    })).resolves.toMatchObject({ kind: 'accepted', credential: { generation: 1 } })
  })

  it('keeps explicit bypass available when the unused registry watcher fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'bypass', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watchers[0]!.emit('error', new Error('watch unavailable'))

    await expect(ctx.authentication.authenticate({ channel: 'http-api' }))
      .resolves.toEqual({ kind: 'accepted' })
    expect(unavailable).not.toHaveBeenCalled()
  })
})
