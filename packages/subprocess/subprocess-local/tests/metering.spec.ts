import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SubprocessMeteredExit, SubprocessMeteredSpawn, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { applyAddressSpaceLimit } from '../src/metering.ts'

function baseSpec(): SubprocessSpawnSpec {
  return {
    argv: ['sleep', '0.05'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore' as const, stdout: 'pipe' as const, stderr: 'pipe' as const },
    graceMs: 1_000,
  }
}

describe('applyAddressSpaceLimit', () => {
  it('returns argv unchanged without limits', () => {
    expect(applyAddressSpaceLimit(['true'], undefined, { platform: 'linux', prlimitAvailable: true })).toEqual(['true'])
  })

  it('returns argv unchanged for a non-positive or non-finite bound', () => {
    const options = { platform: 'linux' as const, prlimitAvailable: true }
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: 0 }, options)).toEqual(['true'])
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: -1 }, options)).toEqual(['true'])
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: Number.NaN }, options)).toEqual(['true'])
  })

  it('returns argv unchanged off Linux or without prlimit', () => {
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: 1_024 }, { platform: 'darwin', prlimitAvailable: false })).toEqual(['true'])
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: 1_024 }, { platform: 'linux', prlimitAvailable: false })).toEqual(['true'])
  })

  it('fronts prlimit on Linux when available', () => {
    expect(applyAddressSpaceLimit(['sleep', '1'], { maxMemoryBytes: 2_048 }, { platform: 'linux', prlimitAvailable: true }))
      .toEqual(['prlimit', '--as=2048', '--', 'sleep', '1'])
  })

  it('floors fractional bounds', () => {
    expect(applyAddressSpaceLimit(['true'], { maxMemoryBytes: 1_024.9 }, { platform: 'linux', prlimitAvailable: true }))
      .toEqual(['prlimit', '--as=1024', '--', 'true'])
  })
})

describe('LocalSubprocessRuntime prlimit probe arms', () => {
  it('honors the explicit availability override', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { prlimitAvailable: false }
    await expect((ctx.subprocess as unknown as { probePrlimit(): Promise<boolean> }).probePrlimit()).resolves.toBe(false)
    await fiber.dispose()
  })

  it('treats non-linux platforms as observe-only', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { platform: 'darwin' }
    await expect((ctx.subprocess as unknown as { probePrlimit(): Promise<boolean> }).probePrlimit()).resolves.toBe(false)
    await fiber.dispose()
  })
})

describe('LocalSubprocessRuntime metering events', () => {
  it('emits spawned and exited with the correlation for metered spawns', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const spawned: SubprocessMeteredSpawn[] = []
    const exited: SubprocessMeteredExit[] = []
    ctx.on('subprocess/spawned', (event) => { spawned.push(event) })
    ctx.on('subprocess/exited', (event) => { exited.push(event) })
    const handle = ctx.subprocess.spawn({
      ...baseSpec(),
      correlation: { sessionId: 's1', commandId: 'c1', kind: 'shell' },
    })
    await handle.done
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(spawned).toHaveLength(1)
    const spawn = spawned[0]
    if (spawn === undefined) throw new Error('metered spawn event missing')
    expect(spawn.correlation).toEqual({ sessionId: 's1', commandId: 'c1', kind: 'shell' })
    expect(spawn.handle.pid).toBeGreaterThan(0)
    expect(exited).toHaveLength(1)
    const exit = exited[0]
    if (exit === undefined) throw new Error('metered exit event missing')
    expect(exit.correlation.commandId).toBe('c1')
    expect(exit.outcome.exitCode).toBe(0)
    await fiber.dispose()
  })

  it('emits nothing for uncorrelated spawns', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    let events = 0
    ctx.on('subprocess/spawned', () => { events += 1 })
    ctx.on('subprocess/exited', () => { events += 1 })
    const handle = ctx.subprocess.spawn(baseSpec())
    await handle.done
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(events).toBe(0)
    await fiber.dispose()
  })
})
