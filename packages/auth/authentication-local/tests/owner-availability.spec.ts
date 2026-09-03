/**
 * Owner-availability transitions and asynchronous containment: a bounded owner
 * schedules its own expiry, an owner that returns re-opens admission, and every
 * queued refresh or watcher failure contains its own reporting failure.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_AUTHENTICATION_CAPABILITIES, authenticationChallengeId } from '@deepseek-ai/dsh-authentication'
import type { AccessRecord } from '../src/access-log.ts'

const registry = vi.hoisted(() => ({
  /** Reads that succeed before the rest fail, or undefined to allow all. */
  failAfter: undefined as number | undefined,
  /** Whether a Grant consumption fails after its challenge was accepted. */
  failConsume: false,
  error: new Error('registry unreadable'),
  reads: 0,
}))
const audit = vi.hoisted(() => ({
  failing: new Set<string>(),
  records: [] as AccessRecord[],
}))

vi.mock('../src/grant-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/grant-registry.ts')>()
  return {
    ...actual,
    readGrantRegistry: async (...args: Parameters<typeof actual.readGrantRegistry>) => {
      registry.reads += 1
      if (registry.failAfter !== undefined && registry.reads > registry.failAfter) throw registry.error
      return await actual.readGrantRegistry(...args)
    },
    consumeAuthenticationGrant: async (...args: Parameters<typeof actual.consumeAuthenticationGrant>) => {
      if (registry.failConsume) throw registry.error
      return await actual.consumeAuthenticationGrant(...args)
    },
  }
})

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  return {
    ...actual,
    appendAccessRecord: async (...args: Parameters<typeof actual.appendAccessRecord>): Promise<void> => {
      audit.records.push(args[0])
      if (audit.failing.has(args[0].event)) throw new Error('access log unavailable')
      await actual.appendAccessRecord(...args)
    },
    appendAccessRecords: async (...args: Parameters<typeof actual.appendAccessRecords>): Promise<void> => {
      audit.records.push(...args[0])
      if (args[0].some(record => audit.failing.has(record.event))) throw new Error('access log unavailable')
      await actual.appendAccessRecords(...args)
    },
  }
})

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
const { approveEnrollmentRequest, createEnrollmentRequest, grantRegistryPath, revokeAuthenticationGrant } = await import('../src/grant-registry.ts')
const { createGrantFixture, signedProof } = await import('./grant-fixture.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  registry.failAfter = undefined
  registry.failConsume = false
  registry.reads = 0
  audit.failing.clear()
  audit.records.length = 0
  watchers.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-owner-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(dshHome: string, config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { mode: 'authenticated', watch: false, ...config, dshHome })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

/** Boot with the fake watcher installed so reloads can be driven directly. */
async function watched(dshHome: string, config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, {
    mode: 'authenticated', ...config, dshHome, watch: true, debounceMs: 1,
  })
  cleanups.push(() => fiber.dispose())
  await fiber
  const watcher = watchers.at(-1)
  if (watcher === undefined) throw new Error('expected a registry watcher')
  return { ctx, watcher, reload: () => { watcher.emit('all', 'change', grantRegistryPath(dshHome)) } }
}

/** Collected logger warnings for one context. */
function warningsOf(ctx: Context): string[] {
  const collected: string[] = []
  ctx.logger.warn = ((message: unknown) => { collected.push(String(message)) }) as typeof ctx.logger.warn
  return collected
}

/** Approve one authorizing device Grant whose authority expires. */
async function boundedOwner(dshHome: string, expiresInMs: number): Promise<void> {
  const { generateKeyPairSync } = await import('node:crypto')
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const request = await createEnrollmentRequest({
    name: 'bounded-owner',
    kind: 'device',
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  }, { dshHome })
  await approveEnrollmentRequest(request.id, {
    capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    expiresInMs,
  }, { dshHome })
}

describe('bounded owner authority', () => {
  it('clears a scheduled owner expiry on disposal', async () => {
    const dshHome = await home()
    // A bounded owner schedules a refresh at its own deadline, so disposal has
    // a live timer to cancel.
    await boundedOwner(dshHome, 60_000)
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    await fiber

    await expect(fiber.dispose()).resolves.not.toThrow()
  })

  it('reopens admission when a bounded owner is replaced before its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    await boundedOwner(dshHome, 60_000)
    const ctx = await boot(dshHome)
    const events: string[] = []
    ctx.on('authentication/unavailable', () => { events.push('unavailable') })
    ctx.on('authentication/available', () => { events.push('available') })

    // Past the owner deadline no authority remains, so a challenge is refused
    // and the deployment seals.
    vi.setSystemTime(new Date('2026-08-17T00:02:00.000Z'))
    const sealed = await ctx.authentication.createChallenge(
      'grant_missing' as Parameters<typeof ctx.authentication.createChallenge>[0],
      'browser-session',
    )
    expect(sealed).toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(events).toEqual(['unavailable'])

    // A fresh owner returns, and the next challenge observes availability again.
    const replacement = await createGrantFixture(dshHome, 'replacement')
    const reopened = await ctx.authentication.createChallenge(replacement.grant.id, 'browser-session')
    expect(reopened.kind).toBe('accepted')
    expect(events).toEqual(['unavailable', 'available'])
  })

  it('observes an owner returning inside a proof exchange', async () => {
    const dshHome = await home()
    // Booting an ownerless home leaves admission sealed, so the exchange is the
    // first operation to see the owner enrolled afterwards.
    const ctx = await boot(dshHome)
    const owner = await createGrantFixture(dshHome, 'owner')
    const events: string[] = []
    ctx.on('authentication/available', () => { events.push('available') })

    // The challenge cannot exist yet, so the exchange refuses the proof itself —
    // but only after it has recognized the returned owner.
    await expect(ctx.authentication.exchangeAccessToken({
      challengeId: authenticationChallengeId('challenge_absent'),
      signature: 'AA',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-proof' })
    expect(events).toEqual(['available'])

    // Admission is open again for a real proof.
    await expect(ctx.authentication.exchangeAccessToken(await signedProof(ctx, owner, 'access-token')))
      .resolves.toMatchObject({ kind: 'accepted' })
  })

  it('refuses a proof exchange once the watcher has failed', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await watched(dshHome)
    const proof = await signedProof(ctx, owner, 'access-token')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    warningsOf(ctx)
    // A lost watcher seals the service, and a valid proof is not evidence it recovered.
    watcher.emit('error', new Error('inotify limit reached'))
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })

    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('reports an unreadable registry during a proof exchange distinctly', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, owner, 'access-token')
    const warnings = warningsOf(ctx)
    registry.failAfter = registry.reads

    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('owner verification unavailable')
  })

  it('refuses an emergency token when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const exchanged = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, owner, 'access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    const admitted = await ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })
    if (admitted.kind !== 'accepted') throw new Error('expected an admission')
    registry.failAfter = registry.reads

    await expect(ctx.authentication.issueEmergencyAccessToken(admitted.principal, ['harniverse.observe'], 60_000))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })
})

describe('expired credentials while sealed', () => {
  it('reports a live session as unavailable once the owner is gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    // The only authority expires in a minute; the session outlives it.
    await boundedOwner(dshHome, 60_000)
    const holder = await createGrantFixture(dshHome, 'holder', ['harniverse.observe'])
    const ctx = await boot(dshHome, { accessTokenTtlMs: 10 * 60_000 })
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, holder, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')

    // A session whose deployment lost its owner is refused as unavailable, not
    // as an invalid credential: the credential itself is still well-formed.
    vi.setSystemTime(new Date('2026-08-17T00:02:00.000Z'))
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('rejects a principal whose own deadline already passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const temporary = await createGrantFixture(dshHome, 'temp', ['harniverse.observe'], 'temporary')
    const ctx = await boot(dshHome, { accessTokenTtlMs: 10 * 60_000 })
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, temporary, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')
    expect(owner.grant.capabilities).toContain('harniverse.authorize')

    // The temporary Grant's own 60s lifetime ends before the session lifetime,
    // so the principal deadline decides.
    vi.setSystemTime(new Date('2026-08-17T00:05:00.000Z'))
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })
})

describe('batch settlement', () => {
  it('leaves an already-rejected admission rejected when the batch record fails', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const exchanged = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, owner, 'access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    warningsOf(ctx)
    audit.failing.add('access-accepted')

    // One valid and one invalid credential share a batch: the accepted one is
    // withdrawn, and the rejected one keeps its own honest reason.
    const [accepted, rejected] = await Promise.all([
      ctx.authentication.authenticate({ channel: 'http-api', authorization: `Bearer ${exchanged.value.value}` }),
      ctx.authentication.authenticate({ channel: 'http-api', authorization: 'Bearer nonsense' }),
    ])
    expect(accepted).toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(rejected).toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })
})

describe('proof exchange failures', () => {
  it('refuses an exchange whose Grant consumption fails', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, owner, 'access-token')
    const warnings = warningsOf(ctx)
    // The proof is valid and the owner is live; the durable read behind the
    // Grant is what fails.
    registry.failConsume = true

    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('challenge exchange unavailable')
  })
})

describe('asynchronous containment', () => {
  it('ignores a watcher event delivered after close', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { watcher, reload } = await watched(dshHome)
    while (cleanups.length > 0) await cleanups.pop()!()
    expect(watcher.closed).toBe(true)

    // A reload or failure reported after disposal is inert.
    expect(() => { reload() }).not.toThrow()
    expect(() => { watcher.emit('error', new Error('late')) }).not.toThrow()
  })

  it('contains an unrecordable Grant revocation reconciliation', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const revoked = await createGrantFixture(dshHome, 'revoked', ['harniverse.observe'])
    const { ctx, reload } = await watched(dshHome)
    const warnings = warningsOf(ctx)
    audit.failing.add('grant-revision-applied')
    await revokeAuthenticationGrant(revoked.grant.id, { dshHome })

    reload()
    await vi.waitFor(() => {
      expect(warnings.join('\n')).toContain('Grant revocation access record failed')
    })
  })

  it('seals a watcher failure silently when admission was already closed', async () => {
    const dshHome = await home()
    // An ownerless home is already sealed, so losing the watcher withdraws
    // nothing and announces nothing.
    const { ctx, watcher } = await watched(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    warningsOf(ctx)

    watcher.emit('error', new Error('inotify limit reached'))
    const owner = await createGrantFixture(dshHome, 'owner')
    // The watcher is gone, so even a fresh owner cannot reopen admission.
    await expect(ctx.authentication.createChallenge(owner.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('contains a throwing unavailability listener during a watcher failure', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { ctx, watcher } = await watched(dshHome)
    const warnings = warningsOf(ctx)
    ctx.on('authentication/unavailable', () => { throw new Error('subscriber exploded') })

    watcher.emit('error', new Error('inotify limit reached'))
    await vi.waitFor(() => {
      expect(warnings.join('\n')).toContain('watcher failure containment failed')
    })
  })

  it('reschedules a bounded owner expiry across a reload', async () => {
    const dshHome = await home()
    // Booting a bounded owner arms a timer; the reload must replace it rather
    // than leaving two live timers behind.
    await boundedOwner(dshHome, 60_000)
    const { reload } = await watched(dshHome)
    const before = await home()
    expect(before).toBeDefined()

    reload()
    await vi.waitFor(() => { expect(registry.reads).toBeGreaterThan(1) })
  })

  it('seals only once while the owner stays gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    // The bounded owner is the only authority; the holder is enrolled while it
    // is still live so the deployment bootstraps.
    await boundedOwner(dshHome, 60_000)
    const holder = await createGrantFixture(dshHome, 'holder', ['harniverse.observe'])
    const ctx = await boot(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    // Two operations observe the same vanished owner; only the first transition
    // is an event.
    vi.setSystemTime(new Date('2026-08-17T00:02:00.000Z'))
    await ctx.authentication.createChallenge(holder.grant.id, 'browser-session')
    await ctx.authentication.createChallenge(holder.grant.id, 'browser-session')
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('keeps a repeated seal from re-emitting unavailability', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const { ctx, reload } = await watched(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    warningsOf(ctx)
    registry.failAfter = registry.reads

    reload()
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
    reload()
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
  })
})
