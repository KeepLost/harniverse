/**
 * Boot-time budget-apply ordering: the init-time apply and the settings
 * attach apply can run concurrently, and the attach apply always read the
 * newer source — a stale in-flight settlement must not overwrite it.
 */

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
import type { GovernorInternals } from '../src/index.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { defaultInternals } from '../src/proc-defaults.ts'

/** Read-only cgroup internals rooted somewhere nonexistent → rlimit tier. */
const deadCgroup = {
  mkdir: async () => {},
  readFile: async () => {
    throw new Error('ENOENT')
  },
  writeFile: async () => {
    throw new Error('EROFS')
  },
  rmdir: async () => {},
  readDir: async () => [],
  accessWrite: async () => false,
}

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('GovernorService boot-apply ordering', () => {
  it('a stale in-flight apply cannot settle over the settings-attached budget', async () => {
    const originalReadFile = defaultInternals.readFile
    let releaseMeminfo: (() => void) | undefined
    const meminfoGated = new Promise<void>((resolve) => { releaseMeminfo = resolve })
    defaultInternals.readFile = async (path: string) => {
      if (path === '/proc/meminfo') {
        await meminfoGated
        // 10 GiB physical, no cgroup ceiling → the auto budget resolves to 8 GiB.
        return 'MemTotal:\t10485760 kB\n'
      }
      throw new Error('ENOENT')
    }

    const root = await mkdtemp(join(tmpdir(), 'dsh-governor-boot-apply-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('agents', { get: () => undefined, list: () => [], roots: () => [] } as never)

    const internals: GovernorInternals = { cgroup: deadCgroup }
    class G extends GovernorService {
      constructor(scope: Context) {
        super(scope, DEFAULT_CONFIG, internals)
      }
    }
    try {
      // No settings service yet: the governor's init-time apply starts against
      // the composition entry (auto) and parks on the gated meminfo read, so
      // the plugin's activation stays in flight.
      void ctx.plugin(G)
      await new Promise((resolve) => { setTimeout(resolve, 200) })

      // The settings attach fires a second apply that reads the stored budget;
      // an explicit budget resolves without meminfo, so it settles immediately
      // while the init-time apply is still parked.
      ctx.provide('settings', {
        register: () => ({
          get: () => ({ ...DEFAULT_CONFIG, memory: { limit: 2 * 1024 ** 3 } }),
          watch: () => () => {},
          update: async () => {},
          replace: async () => {},
        }),
      } as never)

      // Releasing the gated read settles the init-time apply last; it must
      // not overwrite the newer budget.
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      releaseMeminfo?.()
      await new Promise((resolve) => { setTimeout(resolve, 300) })

      expect(ctx.governor.configGet().globalLimitBytes).toBe(2 * 1024 ** 3)
    } finally {
      releaseMeminfo?.()
      defaultInternals.readFile = originalReadFile
      await ctx.fiber.dispose()
    }
  })

  it('a superseded apply stops before rewriting the cgroup parent and leaves', async () => {
    const originalReadFile = defaultInternals.readFile
    let releaseMeminfo: (() => void) | undefined
    const meminfoGated = new Promise<void>((resolve) => { releaseMeminfo = resolve })
    defaultInternals.readFile = async (path: string) => {
      if (path === '/proc/meminfo') {
        await meminfoGated
        return 'MemTotal:\t10485760 kB\n'
      }
      throw new Error('ENOENT')
    }
    let releaseMkdir: (() => void) | undefined
    const mkdirGated = new Promise<void>((resolve) => { releaseMkdir = resolve })
    // A writable-looking cgroup whose mkdir parks, so an apply can be
    // superseded while it is already past the value check and inside
    // ensureParent.
    const gatedCgroup = {
      mkdir: async () => { await mkdirGated },
      readFile: async () => { throw new Error('ENOENT') },
      writeFile: async () => {},
      rmdir: async () => {},
      readDir: async () => [],
      accessWrite: async () => true,
    }

    const root = await mkdtemp(join(tmpdir(), 'dsh-governor-boot-apply-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('agents', { get: () => undefined, list: () => [], roots: () => [] } as never)

    const internals: GovernorInternals = { cgroup: gatedCgroup }
    class G extends GovernorService {
      constructor(scope: Context) {
        super(scope, DEFAULT_CONFIG, internals)
      }
    }
    try {
      void ctx.plugin(G)
      await new Promise((resolve) => { setTimeout(resolve, 200) })

      // First attach apply: explicit budget, resolves without meminfo, then
      // parks inside ensureParent's mkdir.
      const first = ctx.provide('settings', {
        register: () => ({
          get: () => ({ ...DEFAULT_CONFIG, memory: { limit: 2 * 1024 ** 3 } }),
          watch: () => () => {},
          update: async () => {},
          replace: async () => {},
        }),
      } as never)
      await new Promise((resolve) => { setTimeout(resolve, 100) })

      // Re-providing the settings service detaches and re-attaches the
      // section, starting a newer apply that supersedes the parked one.
      first()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      ctx.provide('settings', {
        register: () => ({
          get: () => ({ ...DEFAULT_CONFIG, memory: { limit: 4 * 1024 ** 3 } }),
          watch: () => () => {},
          update: async () => {},
          replace: async () => {},
        }),
      } as never)
      await new Promise((resolve) => { setTimeout(resolve, 100) })

      // The newest apply's value stands once the cgroup gate opens; the
      // superseded apply must not run its own post-ensureParent pass.
      releaseMkdir?.()
      releaseMeminfo?.()
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      expect(ctx.governor.configGet().globalLimitBytes).toBe(4 * 1024 ** 3)
    } finally {
      releaseMkdir?.()
      releaseMeminfo?.()
      defaultInternals.readFile = originalReadFile
      await ctx.fiber.dispose()
    }
  })
})
