/**
 * Registry read failures and browser-login rate limiting: a registry the
 * process cannot read refuses admission rather than trusting a stale view,
 * and repeated invalid logins are blocked per peer with an auditable refusal.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessRecord } from '../src/access-log.ts'

const registry = vi.hoisted(() => ({
  /** Reads that succeed before the rest fail, or undefined to allow all. */
  failAfter: undefined as number | undefined,
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
  }
})

const { default: LocalAuthentication } = await import('../src/index.ts')
const { createGrantFixture, signedProof } = await import('./grant-fixture.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  registry.failAfter = undefined
  registry.reads = 0
  audit.failing.clear()
  audit.records.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-read-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(dshHome: string, config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { ...config, dshHome, mode: 'authenticated', watch: false })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

/** Collected logger warnings for one context. */
function warningsOf(ctx: Context): string[] {
  const collected: string[] = []
  ctx.logger.warn = ((message: unknown) => { collected.push(String(message)) }) as typeof ctx.logger.warn
  return collected
}

/** Stop the registry from being read from this point on. */
function breakRegistry(): void {
  registry.failAfter = registry.reads
}

describe('registry read failures', () => {
  it('refuses a bearer admission when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const exchanged = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, owner, 'access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    const warnings = warningsOf(ctx)
    breakRegistry()

    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('Grant verification unavailable')
  })

  it('refuses a browser admission when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, owner, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')
    const warnings = warningsOf(ctx)
    breakRegistry()

    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('Grant verification unavailable')
  })

  it('refuses a challenge when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const warnings = warningsOf(ctx)
    breakRegistry()

    await expect(ctx.authentication.createChallenge(owner.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('challenge issue unavailable')
  })

  it('refuses an exchange when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, owner, 'access-token')
    const warnings = warningsOf(ctx)
    breakRegistry()

    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('owner verification unavailable')
  })

  it('refuses a status read when the registry cannot be read', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    breakRegistry()

    // Status has no safe fallback: an unknown seal state is not a report.
    await expect(ctx.authentication.status()).rejects.toThrow(/registry unreadable/)
  })

  it('refuses a browser login when the registry cannot be read', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, owner, 'browser-session')
    const warnings = warningsOf(ctx)
    breakRegistry()

    await expect(ctx.authentication.createBrowserSession(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('owner verification unavailable')
  })
})

describe('browser login rate limiting', () => {
  it('blocks a peer after repeated invalid proofs and records the refusal', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome, { authFailureLimit: 2, authFailureWindowMs: 60_000, authFailureBlockMs: 60_000 })
    const bad = async () => {
      const issued = await ctx.authentication.createChallenge(owner.grant.id, 'browser-session')
      if (issued.kind !== 'accepted') throw new Error('expected a challenge')
      return await ctx.authentication.createBrowserSession(
        { challengeId: issued.value.id, signature: 'A'.repeat(86) },
        '10.0.0.9',
      )
    }

    await expect(bad()).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    await expect(bad()).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })

    // The third attempt is refused before its proof is even considered.
    const blocked = await bad()
    expect(blocked).toMatchObject({ kind: 'rejected', reason: 'rate-limited' })
    expect(audit.records.some(record =>
      record.event === 'browser-login-rejected' && record.reasonCode === 'rate-limited')).toBe(true)
  })

  it('refuses a rate-limited login whose record cannot be written', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome, { authFailureLimit: 1, authFailureWindowMs: 60_000, authFailureBlockMs: 60_000 })
    const issued = await ctx.authentication.createChallenge(owner.grant.id, 'browser-session')
    if (issued.kind !== 'accepted') throw new Error('expected a challenge')
    await ctx.authentication.createBrowserSession(
      { challengeId: issued.value.id, signature: 'A'.repeat(86) },
      '10.0.0.9',
    )
    const warnings = warningsOf(ctx)
    audit.failing.add('browser-login-rejected')

    const next = await ctx.authentication.createChallenge(owner.grant.id, 'browser-session')
    if (next.kind !== 'accepted') throw new Error('expected a challenge')
    await expect(ctx.authentication.createBrowserSession(
      { challengeId: next.value.id, signature: 'A'.repeat(86) },
      '10.0.0.9',
    )).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('browser login record failed')
  })

  it('clears a peer block after a successful login', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome, { authFailureLimit: 3, authFailureWindowMs: 60_000, authFailureBlockMs: 60_000 })
    const issued = await ctx.authentication.createChallenge(owner.grant.id, 'browser-session')
    if (issued.kind !== 'accepted') throw new Error('expected a challenge')
    await ctx.authentication.createBrowserSession(
      { challengeId: issued.value.id, signature: 'A'.repeat(86) },
      '10.0.0.9',
    )

    await expect(ctx.authentication.createBrowserSession(
      await signedProof(ctx, owner, 'browser-session'),
      '10.0.0.9',
    )).resolves.toMatchObject({ kind: 'accepted' })

    // The successful login forgave the earlier failure, so the block never
    // accrues even at a limit of three.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = await ctx.authentication.createChallenge(owner.grant.id, 'browser-session')
      if (next.kind !== 'accepted') throw new Error('expected a challenge')
      await expect(ctx.authentication.createBrowserSession(
        { challengeId: next.value.id, signature: 'A'.repeat(86) },
        '10.0.0.9',
      )).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    }
  })

  it('reports an unavailable exchange distinctly from an invalid credential', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, owner, 'browser-session')
    breakRegistry()

    // Unavailability is not the caller's fault, so it is not invalid-credential.
    await expect(ctx.authentication.createBrowserSession(proof, '10.0.0.9'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })
})

describe('enrollment input refusal', () => {
  it('maps a validation failure to its stable reason without throwing', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.requestEnrollment({
      name: '', kind: 'device', publicKey: 'AAAA',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-name' })
    await expect(ctx.authentication.requestEnrollment({
      name: 'device', kind: 'device', publicKey: 'not-a-key',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-public-key' })
  })

  it('propagates an unexpected enrollment failure to the caller', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const ctx = await boot(dshHome)
    // A failed mandatory access record is neither an input rejection nor a
    // capacity refusal, so it is not projected as one.
    audit.failing.add('enrollment-requested')

    await expect(ctx.authentication.requestEnrollment({
      name: 'device', kind: 'device', publicKey: owner.grant.publicKey,
    })).rejects.toThrow(/access log unavailable/)
  })
})
