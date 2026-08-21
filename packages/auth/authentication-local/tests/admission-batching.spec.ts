import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessLogOptions, AccessRecord } from '../src/access-log.ts'

const audit = vi.hoisted(() => ({
  batches: [] as AccessRecord[][],
  error: undefined as Error | undefined,
  pending: undefined as Promise<void> | undefined,
  registryReads: 0,
}))

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  return {
    ...actual,
    appendAccessRecords: async (records: AccessRecord[], _options?: AccessLogOptions): Promise<void> => {
      audit.batches.push(records)
      if (audit.error !== undefined) throw audit.error
      await audit.pending
    },
  }
})

vi.mock('../src/grant-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/grant-registry.ts')>()
  return {
    ...actual,
    readGrantRegistry: async (...args: Parameters<typeof actual.readGrantRegistry>) => {
      audit.registryReads += 1
      return actual.readGrantRegistry(...args)
    },
  }
})

import LocalAuthentication from '../src/index.ts'
import { createGrantFixture, signedProof } from './grant-fixture.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  audit.batches.length = 0
  audit.error = undefined
  audit.pending = undefined
  audit.registryReads = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-admission-batch-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(dshHome: string, mode: 'authenticated' | 'bypass') {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode, watch: false })
  cleanups.push(() => fiber.dispose())
  await fiber
  return { ctx, fiber }
}

describe('authentication admission batching', () => {
  it('durably appends a concurrent admission cohort before releasing its decisions', async () => {
    const { ctx } = await boot(await home(), 'bypass')

    let release!: () => void
    audit.pending = new Promise<void>((resolve) => { release = resolve })
    const decisions = Array.from({ length: 6 }, () => ctx.authentication.authenticate({
      channel: 'http-api',
      peerAddress: '127.0.0.1',
    }))
    let settled = false
    void Promise.all(decisions).then(() => { settled = true })

    await vi.waitFor(() => {
      expect(audit.batches).toHaveLength(1)
      expect(audit.batches[0]).toHaveLength(6)
    })
    expect(settled).toBe(false)

    release()
    await expect(Promise.all(decisions)).resolves.toEqual(Array.from({ length: 6 }, () => ({
      kind: 'accepted',
      principal: {
        kind: 'bypass',
        capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
      },
    })))
  })

  it('shares one durable Grant registry read across authenticated peers in the cohort', async () => {
    const dshHome = await home()
    const fixture = await createGrantFixture(dshHome, 'owner')
    const { ctx } = await boot(dshHome, 'authenticated')
    const login = await ctx.authentication.createBrowserSession(await signedProof(ctx, fixture, 'browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected browser session')
    audit.batches.length = 0
    audit.registryReads = 0

    const decisions = await Promise.all(Array.from({ length: 6 }, () => ctx.authentication.authenticate({
      channel: 'http-api',
      browserSession: login.session.value,
      peerAddress: '127.0.0.1',
    })))

    for (const decision of decisions) {
      if (decision.kind !== 'accepted' || decision.principal.kind !== 'grant') {
        throw new Error('expected Grant admission')
      }
      expect(decision.principal.grantId).toBe(fixture.grant.id)
    }
    expect(audit.registryReads).toBe(1)
    expect(audit.batches).toHaveLength(1)
    expect(audit.batches[0]).toHaveLength(6)
  })

  it('fails accepted admissions closed when the cohort audit cannot persist', async () => {
    const { ctx } = await boot(await home(), 'bypass')
    audit.error = new Error('audit unavailable')

    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toEqual({
      kind: 'rejected',
      reason: 'authentication-unavailable',
    })
    expect(audit.batches).toHaveLength(1)
    expect(audit.batches[0]).toHaveLength(1)
  })

  it('drains a scheduled admission cohort during Provider disposal', async () => {
    const { ctx, fiber } = await boot(await home(), 'bypass')
    const decision = ctx.authentication.authenticate({ channel: 'http-api' })

    await fiber.dispose()

    await expect(decision).resolves.toMatchObject({ kind: 'accepted' })
  })
})
