import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => ({
  refreshError: undefined as Error | undefined,
  resetStarted: undefined as (() => void) | undefined,
  resetRecord: undefined as Promise<void> | undefined,
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
      if (!target.endsWith('/auth/tokens.json')) return actual.withPrivateFileLock(target, operation)
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
      if (args[0].event === 'token-rotation-applied' && audit.refreshError !== undefined) {
        throw audit.refreshError
      }
      if (args[0].event === 'token-reset' && audit.resetRecord !== undefined) {
        audit.resetStarted?.()
        return audit.resetRecord
      }
      return actual.appendAccessRecord(...args)
    },
  }
})

import LocalAuthentication from '../src/index.ts'
import { addAuthenticationToken, resetAuthenticationToken } from '../src/management.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  audit.refreshError = undefined
  audit.resetStarted = undefined
  audit.resetRecord = undefined
  registryLock.active = 0
  registryLock.contender = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
  watchers.length = 0
})

describe('audited token mutation rollback', () => {
  it('does not publish or apply a reset whose audit record fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-audit-rollback-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const browser = await ctx.authentication.createBrowserSession(token.token)
    expect(browser.kind).toBe('accepted')
    if (browser.kind !== 'accepted') throw new Error('expected browser login to succeed')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let rejectAudit!: (error: Error) => void
    let markReadAttempt!: () => void
    const readAttempt = new Promise<void>((resolve) => { markReadAttempt = resolve })
    audit.resetStarted = markStarted
    audit.resetRecord = new Promise<void>((_resolve, reject) => { rejectAudit = reject })
    registryLock.contender = markReadAttempt
    const reset = resetAuthenticationToken('laptop', { dshHome })
    await started
    watchers[0]!.emit('all', 'change')
    await readAttempt
    rejectAudit(new Error('audit unavailable'))

    await expect(reset).rejects.toThrow('audit unavailable')
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      cookie: `dsh_auth=${browser.session.value}`,
    })).resolves.toMatchObject({ kind: 'accepted', credential: { generation: 1 } })
    expect(revoked).not.toHaveBeenCalled()
  })

  it('publishes a committed reset when its refresh access record fails', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-refresh-audit-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const token = await addAuthenticationToken('laptop', { dshHome })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const browser = await ctx.authentication.createBrowserSession(token.token)
    if (browser.kind !== 'accepted') throw new Error('expected browser login to succeed')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    await resetAuthenticationToken('laptop', { dshHome })
    audit.refreshError = new Error('refresh audit unavailable')
    watchers[0]!.emit('all', 'change')

    await vi.waitFor(() => { expect(revoked).toHaveBeenCalledTimes(1) })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      cookie: `dsh_auth=${browser.session.value}`,
    })).resolves.toMatchObject({ kind: 'rejected' })
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
