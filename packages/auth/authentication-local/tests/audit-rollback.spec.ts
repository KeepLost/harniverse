import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => ({
  refreshError: undefined as Error | undefined,
  refreshRecord: undefined as Promise<void> | undefined,
  loginError: undefined as Error | undefined,
  mutationStarted: undefined as (() => void) | undefined,
  mutationRecord: undefined as Promise<void> | undefined,
}))
const registryLock = vi.hoisted(() => ({
  active: 0,
  contender: undefined as (() => void) | undefined,
}))

vi.mock('../src/private-files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/private-files.ts')>()
  return {
    ...actual,
    withPrivateFileLock: async <T>(target: string, operation: () => Promise<T>): Promise<T> => {
      if (!target.endsWith(join('auth', 'grants.json'))) return actual.withPrivateFileLock(target, operation)
      if (registryLock.active > 0) registryLock.contender?.()
      registryLock.active += 1
      try {
        return await actual.withPrivateFileLock(target, operation)
      } finally {
        registryLock.active -= 1
      }
    },
  }
})

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  return {
    ...actual,
    appendAccessRecord: async (...args: Parameters<typeof actual.appendAccessRecord>) => {
      if ((args[0].event === 'browser-login-accepted' || args[0].event === 'browser-login-rejected')
        && audit.loginError !== undefined) throw audit.loginError
      if (args[0].event === 'grant-revision-applied' && audit.refreshError !== undefined) {
        throw audit.refreshError
      }
      if (args[0].event === 'grant-revision-applied' && audit.refreshRecord !== undefined) return audit.refreshRecord
      if (args[0].event === 'grant-revoked' && audit.mutationRecord !== undefined) {
        audit.mutationStarted?.()
        return audit.mutationRecord
      }
      return actual.appendAccessRecord(...args)
    },
  }
})

import LocalAuthentication from '../src/index.ts'
import { revokeAuthenticationGrant } from '../src/grant-registry.ts'
import { createGrantFixture, signedProof } from './grant-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
const auditTestTimeoutMs = process.platform === 'win32' ? 600_000 : 15_000

afterEach(async () => {
  audit.refreshError = undefined
  audit.refreshRecord = undefined
  audit.loginError = undefined
  audit.mutationStarted = undefined
  audit.mutationRecord = undefined
  registryLock.active = 0
  registryLock.contender = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
  watchers.length = 0
})

describe('audited Grant mutation rollback', () => {
  it('returns authentication-unavailable when browser-login audit records fail', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-login-audit-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    cleanups.push(() => fiber.dispose())
    await fiber

    const acceptedProof = await signedProof(ctx, laptop, 'browser-session')
    audit.loginError = new Error('login audit unavailable')
    await expect(ctx.authentication.createBrowserSession(acceptedProof)).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })

    audit.loginError = undefined
    const rejectedProof = await signedProof(ctx, laptop, 'browser-session')
    audit.loginError = new Error('login audit unavailable')
    await expect(ctx.authentication.createBrowserSession({ ...rejectedProof, signature: 'invalid' })).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })
  })

  it('does not publish or apply a revocation whose audit record fails', { timeout: auditTestTimeoutMs }, async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-audit-rollback-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const browser = await ctx.authentication.createBrowserSession(await signedProof(ctx, laptop, 'browser-session'))
    expect(browser.kind).toBe('accepted')
    if (browser.kind !== 'accepted') throw new Error('expected browser login to succeed')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let rejectAudit!: (error: Error) => void
    let markReadAttempt!: () => void
    const readAttempt = new Promise<void>((resolve) => { markReadAttempt = resolve })
    audit.mutationStarted = markStarted
    audit.mutationRecord = new Promise<void>((_resolve, reject) => { rejectAudit = reject })
    registryLock.contender = markReadAttempt
    const revocation = revokeAuthenticationGrant(laptop.grant.id, { dshHome })
    await started
    watchers[0]!.emit('all', 'change')
    await readAttempt
    rejectAudit(new Error('audit unavailable'))

    await expect(revocation).rejects.toThrow('audit unavailable')
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      browserSession: browser.session.value,
    })).resolves.toMatchObject({ kind: 'accepted', principal: { grantId: laptop.grant.id } })
    expect(revoked).not.toHaveBeenCalled()
  })

  it('publishes a committed revocation when its refresh access record fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-refresh-audit-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const browser = await ctx.authentication.createBrowserSession(await signedProof(ctx, laptop, 'browser-session'))
    if (browser.kind !== 'accepted') throw new Error('expected browser login to succeed')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    await revokeAuthenticationGrant(laptop.grant.id, { dshHome })
    audit.refreshError = new Error('refresh audit unavailable')
    watchers[0]!.emit('all', 'change')

    await vi.waitFor(() => { expect(revoked).toHaveBeenCalledTimes(1) })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      browserSession: browser.session.value,
    })).resolves.toMatchObject({ kind: 'rejected' })
  })

  it('publishes revocation before a slow refresh access record settles', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-refresh-audit-order-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)
    let releaseAudit!: () => void
    audit.refreshRecord = new Promise<void>((resolve) => { releaseAudit = resolve })

    await revokeAuthenticationGrant(laptop.grant.id, { dshHome })
    watchers[0]!.emit('all', 'change')

    await vi.waitFor(() => { expect(revoked).toHaveBeenCalledOnce() })
    releaseAudit()
  })
})

const watchers: FakeWatcher[] = []

class FakeWatcher {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  close(): Promise<void> { return Promise.resolve() }
}

vi.mock('chokidar', () => ({
  watch: () => {
    const watcher = new FakeWatcher()
    watchers.push(watcher)
    return watcher
  },
}))
