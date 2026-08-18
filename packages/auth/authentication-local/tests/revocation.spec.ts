import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  grantRegistryPath,
  revokeAuthenticationGrant,
} from '../src/grant-registry.ts'
import LocalAuthentication from '../src/index.ts'
import { createGrantFixture, signedProof } from './grant-fixture.ts'

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

async function home(): Promise<string> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-revocation-'))
  cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
  return dshHome
}

async function mounted(dshHome: string, reconcileIntervalMs = 5_000): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', debounceMs: 0, reconcileIntervalMs })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

describe('Grant registry revocation publication', () => {
  it('publishes only the exact revoked Grant revision', async () => {
    const dshHome = await home()
    const laptop = await createGrantFixture(dshHome, 'laptop')
    await createGrantFixture(dshHome, 'ci')
    const ctx = await mounted(dshHome)
    const seen: string[] = []
    ctx.on('authentication/revoked', ({ grants }) => { seen.push(...grants.map(grant => grant.grantId)) })

    await revokeAuthenticationGrant(laptop.grant.id, { dshHome })
    watchers[0]!.emit('all', 'change')

    await vi.waitFor(() => { expect(seen).toEqual([laptop.grant.id]) })
  })

  it('fails closed on watcher error, clears process credentials, and recovers after reconciliation', async () => {
    const dshHome = await home()
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = await mounted(dshHome)
    const firstProof = await signedProof(ctx, laptop, 'access-token')
    const first = await ctx.authentication.exchangeAccessToken(firstProof)
    if (first.kind !== 'accepted') throw new Error('expected Access Token')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watchers[0]!.emit('error', new Error('watch unavailable'))
    await expect(ctx.authentication.authenticate({ channel: 'http-api', authorization: `Bearer ${first.value.value}` }))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(unavailable).toHaveBeenCalledOnce()

    watchers[0]!.emit('all', 'change')
    await vi.waitFor(async () => {
      const challenge = await ctx.authentication.createChallenge(laptop.grant.id, 'access-token')
      expect(challenge.kind).toBe('accepted')
    })
  })

  it('reconciles a missed Grant revocation on the fallback interval', async () => {
    const dshHome = await home()
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const ctx = await mounted(dshHome, 10)
    const seen: string[] = []
    ctx.on('authentication/revoked', ({ grants }) => { seen.push(...grants.map(grant => grant.grantId)) })

    await revokeAuthenticationGrant(laptop.grant.id, { dshHome })

    await vi.waitFor(() => { expect(seen).toEqual([laptop.grant.id]) })
  })

  it('fails closed for an unreadable registry and recovers after valid content returns', async () => {
    const dshHome = await home()
    const laptop = await createGrantFixture(dshHome, 'laptop')
    const path = grantRegistryPath(dshHome)
    const registry = await readFile(path, 'utf8')
    const ctx = await mounted(dshHome)
    const unavailable = vi.fn()
    const available = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    ctx.on('authentication/available', available)

    await writeFile(path, '{invalid json', 'utf8')
    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
    await expect(ctx.authentication.createChallenge(laptop.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })

    await writeFile(path, registry, 'utf8')
    watchers[0]!.emit('all', 'change')
    await vi.waitFor(() => { expect(available).toHaveBeenCalledOnce() })
    await expect(ctx.authentication.createChallenge(laptop.grant.id, 'access-token'))
      .resolves.toMatchObject({ kind: 'accepted' })
  })

  it('keeps explicit bypass available when the unused registry watcher fails', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'bypass', debounceMs: 0 })
    cleanups.push(() => fiber.dispose())
    await fiber
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    watchers[0]!.emit('error', new Error('watch unavailable'))

    await expect(ctx.authentication.authenticate({ channel: 'http-api' }))
      .resolves.toMatchObject({ kind: 'accepted', principal: { kind: 'bypass' } })
    expect(unavailable).not.toHaveBeenCalled()
  })
})
