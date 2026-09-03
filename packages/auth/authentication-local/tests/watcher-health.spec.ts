/**
 * Registry watcher health: a filesystem watcher that fails or a reload that
 * cannot be parsed withdraws every process credential and reports global
 * unavailability, and a recovered reload restores admission.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const watchers: FakeWatcher[] = []

/** Chokidar stand-in whose lifecycle events the test drives directly. */
class FakeWatcher {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  closed = false

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

vi.mock('chokidar', () => ({
  watch: () => {
    const watcher = new FakeWatcher()
    watchers.push(watcher)
    return watcher
  },
}))

const { default: LocalAuthentication } = await import('../src/index.ts')
const { grantRegistryPath } = await import('../src/grant-registry.ts')
const { createGrantFixture, signedProof } = await import('./grant-fixture.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  watchers.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-watch-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

/** Boot with the fake watcher installed, returning it alongside the context. */
async function booted(dshHome: string, mode: 'authenticated' | 'bypass' = 'authenticated') {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode, watch: true, debounceMs: 1 })
  cleanups.push(() => fiber.dispose())
  await fiber
  const watcher = watchers.at(-1)
  if (watcher === undefined) throw new Error('expected a registry watcher')
  return { ctx, watcher }
}

/** Collected logger warnings for one context. */
function warningsOf(ctx: Context): string[] {
  const collected: string[] = []
  ctx.logger.warn = ((message: unknown) => { collected.push(String(message)) }) as typeof ctx.logger.warn
  return collected
}

describe('registry watcher health', () => {
  it('withdraws every credential and seals admission when the watcher fails', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await booted(dshHome)
    const exchanged = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, owner, 'access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    const warnings = warningsOf(ctx)

    watcher.emit('error', new Error('inotify limit reached'))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })

    // A live credential does not survive losing sight of its registry.
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('Grant registry watcher failed')
  })

  it('refuses every credential operation once the watcher has failed', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await booted(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watcher.emit('error', new Error('watch failed'))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })

    await expect(ctx.authentication.createChallenge(owner.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    await expect(ctx.authentication.requestEnrollment({
      name: 'device', kind: 'device', publicKey: owner.grant.publicKey,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    await expect(ctx.authentication.issueEmergencyAccessToken({
      kind: 'grant',
      grantId: owner.grant.id,
      name: owner.grant.name,
      grantRevision: owner.grant.revision,
      capabilities: [...owner.grant.capabilities],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, ['harniverse.observe'], 60_000)).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('reports only once across repeated watcher failures', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await booted(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watcher.emit('error', new Error('first'))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
    watcher.emit('error', new Error('second'))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
  })

  it('ignores a watcher failure in bypass mode', async () => {
    const dshHome = await home()
    const { ctx, watcher } = await booted(dshHome, 'bypass')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watcher.emit('error', new Error('watch failed'))
    // Bypass admission never depended on the registry.
    await expect(ctx.authentication.authenticate({ channel: 'http-api' }))
      .resolves.toMatchObject({ kind: 'accepted' })
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('keeps the last good registry when a reload cannot be parsed', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await booted(dshHome)
    expect(await ctx.authentication.status()).toMatchObject({ sealed: false })
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    const warnings = warningsOf(ctx)

    await writeFile(grantRegistryPath(dshHome), 'not json at all\n', { mode: 0o600 })
    watcher.emit('all', 'change', grantRegistryPath(dshHome))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
    expect(warnings.join('\n')).toContain('keeping the last good registry')

    await expect(ctx.authentication.authenticate({ channel: 'http-api' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('refreshes on the watcher ready event', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await booted(dshHome)

    // Readiness is a reload opportunity, not a failure.
    watcher.emit('ready')
    await vi.waitFor(async () => {
      expect(await ctx.authentication.status()).toMatchObject({ sealed: false })
    })
  })

  it('closes its watcher on disposal', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: true, debounceMs: 1 })
    await fiber
    const watcher = watchers.at(-1)
    if (watcher === undefined) throw new Error('expected a registry watcher')

    await fiber.dispose()
    expect(watcher.closed).toBe(true)
    // A watcher event after disposal is inert.
    expect(() => { watcher.emit('error', new Error('late')) }).not.toThrow()
  })
})

describe('revocation reconciliation', () => {
  it('drops browser sessions belonging to a revoked Grant revision', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const device = await createGrantFixture(dshHome, 'device', ['harniverse.observe'])
    const { ctx, watcher } = await booted(dshHome)
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, device, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    const { revokeAuthenticationGrant } = await import('../src/grant-registry.ts')
    await revokeAuthenticationGrant(device.grant.id, { dshHome })
    watcher.emit('all', 'change', grantRegistryPath(dshHome))
    await vi.waitFor(() => { expect(revoked).toHaveBeenCalledOnce() })

    // The session is gone from the process, not merely refused at the edge.
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('keeps a session whose Grant was untouched by the revocation', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const kept = await createGrantFixture(dshHome, 'kept', ['harniverse.observe'])
    const dropped = await createGrantFixture(dshHome, 'dropped', ['harniverse.observe'])
    const { ctx, watcher } = await booted(dshHome)
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, kept, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')
    const revoked = vi.fn()
    ctx.on('authentication/revoked', revoked)

    const { revokeAuthenticationGrant } = await import('../src/grant-registry.ts')
    await revokeAuthenticationGrant(dropped.grant.id, { dshHome })
    watcher.emit('all', 'change', grantRegistryPath(dshHome))
    await vi.waitFor(() => { expect(revoked).toHaveBeenCalledOnce() })

    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toMatchObject({ kind: 'accepted' })
  })
})
