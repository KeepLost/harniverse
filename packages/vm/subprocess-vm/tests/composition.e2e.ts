import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { probeWorld, QemuLocalWorld } from '@deepseek-ai/dsh-vm-qemu-local'
import VmSubprocessRuntime from '../src/index.ts'

/**
 * Real-composition e2e: the provider serves `ctx.subprocess` over one real
 * QEMU world and model-facing process operations run inside the guest.
 * Skips without a usable binary or staged assets (CI lanes provision
 * neither).
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

describe.skipIf(!worldAvailable)('subprocess-vm: real world composition', () => {
  it('resolves, spawns, collects, terminates, and runs terminals inside the guest', async () => {
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, {})
    await world.ready
    await ctx.plugin(VmSubprocessRuntime)
    try {
      await expect(ctx.subprocess.resolveExecutable('busybox')).resolves.toBe('/bin/busybox')
      await expect(ctx.subprocess.resolveExecutable('definitely-missing-tool')).rejects.toThrow("no such executable in the world's PATH")

      const spawned = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'echo composition'],
        cwd: '/tmp',
        graceMs: 2_000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 1_000 } },
      })
      await expect(spawned.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(spawned.collected.stdout!.readFrom(0).text).toBe('composition\n')

      const batched = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'cat'],
        cwd: '/tmp',
        graceMs: 2_000,
        stdio: { stdin: { data: 'ping' }, stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 1_000 } },
      })
      await expect(batched.done).resolves.toMatchObject({ exitCode: 0 })
      expect(batched.collected.stdout!.readFrom(0).text).toBe('ping')

      const stuck = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'sleep 30'],
        cwd: '/tmp',
        graceMs: 300,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
      })
      stuck.terminate()
      const outcome = await stuck.done
      expect(outcome.exitCode).not.toBe(0)

      const terminal = await ctx.subprocess.spawnTerminal({
        argv: ['sh'],
        cwd: '/tmp',
        rows: 24,
        cols: 80,
        graceMs: 300,
      })
      const seen: string[] = []
      terminal.output.on('data', (chunk: Buffer) => { seen.push(chunk.toString('utf8')) })
      await terminal.write('echo terminal-ok\n')
      await new Promise((resolve) => { setTimeout(resolve, 800) })
      await terminal.terminate()
      await terminal.done
      expect(seen.join('')).toContain('terminal-ok')
      expect(world.descriptor.provider).toBe('qemu-local')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)
})
