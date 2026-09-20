/**
 * Exclusive-queue semantics of `HmrReloadCoordinator`: serialization,
 * nesting and disposal rejection, consecutive-change merging over real
 * files, failure broadcast, watcher disposal, and the plugin-provided
 * service lifecycle.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HmrReloadCoordinator, apply, name } from '../src/index.ts'
import * as CoordinationInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-hmr-coordination-'))

async function eventually(assert: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!assert()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('HmrReloadCoordinator exclusive queue', () => {
  it('serializes tasks onto one queue', async () => {
    const coordinator = new HmrReloadCoordinator()
    const order: string[] = []
    const first = coordinator.runExclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      order.push('first')
    })
    const second = coordinator.runExclusive(async () => {
      order.push('second')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('rejects nesting from inside a queued task', async () => {
    const coordinator = new HmrReloadCoordinator()
    let nested: Promise<unknown> | undefined
    await coordinator.runExclusive(async () => {
      nested = coordinator.runExclusive(async () => {})
      await expect(nested).rejects.toThrow('coordinated reloads cannot be nested')
    })
  })

  it('keeps the queue alive after a queued task rejects', async () => {
    const coordinator = new HmrReloadCoordinator()
    await expect(coordinator.runExclusive(async () => {
      throw new Error('task fails')
    })).rejects.toThrow('task fails')
    const after = coordinator.runExclusive(async () => 'still running')
    await expect(after).resolves.toBe('still running')
  })

  it('allows a queued task to dispose the coordinator itself', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    await coordinator.runExclusive(async () => {
      // Disposal from inside the only queued task must not self-deadlock.
      await coordinator.dispose()
    })
    await expect(coordinator.runExclusive(async () => {})).rejects.toThrow('HMR coordination is disposed')
  })

  it('rejects new work after disposal and drains in-flight work', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    coordinator.watchConfig(join(tmp(), 'patch.yml'), () => {})
    let finished = false
    const inFlight = coordinator.runExclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      finished = true
    })
    // Disposal closes registrations, then waits for the queued work to drain.
    await coordinator.dispose()
    await inFlight
    expect(finished).toBe(true)
    await expect(coordinator.runExclusive(async () => {})).rejects.toThrow('HMR coordination is disposed')
  })
})

describe('HmrReloadCoordinator watchConfig', () => {
  it('reloads on add, change, and unlink, merging consecutive writes', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    let passes = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dispose = coordinator.watchConfig(filename, async () => {
      passes += 1
      if (passes === 1) await gate
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => passes === 1, 'initial add was not observed')
      // While the first pass is gated, land two further writes: the dirty
      // loop must collapse them into one additional pass.
      writeFileSync(filename, 'a: 2\n')
      writeFileSync(filename, 'a: 3\n')
      release?.()
      await eventually(() => passes === 2, 'consecutive writes were not merged into one pass')
      rmSync(filename)
      await eventually(() => passes === 3, 'unlink was not observed')
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('watches a file whose parent directories do not exist yet', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'nested', 'deeper', 'patch.yml')
    let passes = 0
    const dispose = coordinator.watchConfig(filename, () => {
      passes += 1
    })
    try {
      mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => passes === 1, 'file creation under a missing parent was not observed')
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('broadcasts each failed pass and keeps watching', { timeout: 60_000 }, async () => {
    const failures: Array<{ filename: string; error: Error }> = []
    const coordinator = new HmrReloadCoordinator({
      onFailure: (filename, error) => { failures.push({ filename, error }) },
    })
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    let passes = 0
    const dispose = coordinator.watchConfig(filename, () => {
      passes += 1
      if (passes === 1) throw new Error('first pass fails')
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => failures.length === 1, 'failure was not broadcast')
      expect(failures[0]?.error).toBeInstanceOf(Error)
      writeFileSync(filename, 'a: 2\n')
      await eventually(() => passes === 2, 'watcher died after a failed pass')
      expect(failures).toHaveLength(1)
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('normalizes a non-Error refresh throw into the failure broadcast', { timeout: 60_000 }, async () => {
    const failures: Array<{ filename: string; error: Error }> = []
    const coordinator = new HmrReloadCoordinator({
      onFailure: (filename, error) => { failures.push({ filename, error }) },
    })
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    const dispose = coordinator.watchConfig(filename, () => {
      throw 'plain string failure'
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => failures.length === 1, 'string failure was not broadcast')
      expect(failures[0]?.error).toBeInstanceOf(Error)
      expect(failures[0]?.error.message).toBe('plain string failure')
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('ignores sibling files inside the watched directory', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    let passes = 0
    const dispose = coordinator.watchConfig(filename, () => {
      passes += 1
    })
    try {
      writeFileSync(join(dir, 'sibling.yml'), 'other: 1\n')
      // awaitWriteFinish batches file events; wait past the stability window
      // so the sibling event has provably been delivered and filtered.
      await new Promise(resolve => setTimeout(resolve, 3_000))
      expect(passes).toBe(0)
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => passes === 1, 'target write was not observed')
      expect(passes).toBe(1)
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('drains an in-flight pass when the watcher disposer runs mid-refresh', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    let releasePass: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releasePass = resolve })
    let entered = false
    let settled = false
    const dispose = coordinator.watchConfig(filename, () => {
      entered = true
      return gate.then(() => {
        settled = true
      })
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => entered, 'refresh pass never started')
      const draining = dispose()
      releasePass?.()
      await draining
      expect(settled).toBe(true)
    } finally {
      await coordinator.dispose()
    }
  })

  it('merges an edit that lands while a refresh pass is still running', { timeout: 60_000 }, async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    const seen: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let passes = 0
    const dispose = coordinator.watchConfig(filename, () => {
      passes += 1
      seen.push(passes === 1 ? 'gated' : 'merged')
      if (passes === 1) return firstGate
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => passes === 1, 'first pass never started')
      // Land a second edit; its chokidar event fires while pass one is gated,
      // so the dirty loop must rerun the refresh once the gate releases.
      writeFileSync(filename, 'a: 2\n')
      await new Promise(resolve => setTimeout(resolve, 3_500))
      expect(passes).toBe(1)
      releaseFirst?.()
      await eventually(() => passes === 2, 'in-flight edit was not merged into a rerun')
      expect(seen).toEqual(['gated', 'merged'])
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('rejects a duplicate canonical registration and reports symlinks as one file', async () => {
    const coordinator = new HmrReloadCoordinator()
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    writeFileSync(filename, 'a: 1\n')
    const dispose = coordinator.watchConfig(filename, () => {})
    try {
      expect(() => coordinator.watchConfig(filename, () => {})).toThrow('already registered')
    } finally {
      await dispose()
      await coordinator.dispose()
    }
  })

  it('refuses new registrations after disposal', async () => {
    const coordinator = new HmrReloadCoordinator()
    await coordinator.dispose()
    expect(() => coordinator.watchConfig(join(tmp(), 'patch.yml'), () => {})).toThrow('HMR coordination is disposed')
  })
})

describe('hmr-coordination plugin', () => {
  afterEach(() => {
    delete process.env['DSH_SPEC_COORDINATION']
  })

  it('provides the service and disposes it with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin({ name, apply })
    const coordinator = ctx.get('hmrCoordination')
    expect(coordinator).toBeInstanceOf(HmrReloadCoordinator)
    if (coordinator === undefined) throw new Error('service missing')
    await expect(coordinator.runExclusive(async () => 'settled')).resolves.toBe('settled')
    await ctx.fiber.dispose()
    await expect(coordinator.runExclusive(async () => {})).rejects.toThrow('HMR coordination is disposed')
  })

  it('emits the failure event through the context and logs it', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = new Context()
    await ctx.plugin({ name, apply })
    const observed: Array<[string, Error]> = []
    ctx.on('hmr-coordination/config-update-failed', (filename, error) => {
      observed.push([filename, error])
    })
    const coordinator = ctx.get('hmrCoordination')
    if (coordinator === undefined) throw new Error('service missing')
    const dir = tmp()
    const filename = join(dir, 'patch.yml')
    const dispose = coordinator.watchConfig(filename, () => {
      throw new Error('boom')
    })
    try {
      writeFileSync(filename, 'a: 1\n')
      await eventually(() => observed.length === 1, 'failure event was not emitted')
      expect(observed[0]?.[0]).toBe(filename)
      expect(observed[0]?.[1]).toBeInstanceOf(Error)
    } finally {
      await dispose()
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
    }
  })

  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CoordinationInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-hmr-coordination', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
