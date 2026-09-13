
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore from '@deepseek-ai/dsh-session'
import GovernorService from '../src/index.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('sweep before first tick', () => {
  it('derives the cutoff from the wall clock and tolerates an absent history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-governor-sweep0-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('agents', { get: () => undefined, list: () => [], roots: () => [] } as never)
    class G extends GovernorService {
      constructor(scope: Context) {
        super(scope, { ...DEFAULT_CONFIG, sampling: { baseMs: 3_600_000, hotMs: 3_600_000 } }, {})
      }
    }
    await ctx.plugin(G)
    const service = ctx.governor as unknown as { sweep(): Promise<void>; history: unknown; lastTick: unknown }
    service.history = undefined
    service.lastTick = undefined
    await expect(service.sweep()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})
