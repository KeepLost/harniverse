/**
 * QemuLocalWorld service tests over the real qemu-stub harness: the service
 * registers as `ctx.vm` from its constructor, forwards the seam surface to
 * the booted handle, reports the neutral descriptor facts, fails closed
 * before settlement, and destroys the world on context disposal.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { QemuLocalWorld } from '../src/index.ts'
import type { ChildLike, VmDeps } from '../src/vm.ts'

const stubPath = fileURLToPath(new URL('./qemu-stub.mjs', import.meta.url))

interface Recording {
  child: ChildProcess
  exit: Promise<{ code: number | null; signal: string | null }>
}

function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-assets-'))
  writeFileSync(join(dir, 'vmlinuz-virt'), 'kernel')
  writeFileSync(join(dir, 'initramfs.cpio.gz'), 'initrd')
  return dir
}

function stubDeps(mode: string, recording: { current?: Recording }): VmDeps {
  return {
    spawn: (argv, options): ChildLike => {
      const [, ...rest] = argv
      const child = spawn(process.execPath, [stubPath, ...rest], { ...options, env: { ...process.env, DSH_STUB_MODE: mode } })
      recording.current = {
        child,
        exit: new Promise((resolve) => { child.on('exit', (code, signal) => { resolve({ code, signal }) }) }),
      }
      return child
    },
  }
}

const recordings: { current?: Recording }[] = []

afterEach(() => {
  for (const recording of recordings.splice(0)) {
    recording.current?.child.kill('SIGKILL')
  }
})

describe('QemuLocalWorld service', () => {
  it('registers as ctx.vm from construction and forwards the seam surface', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, { assetsDir: stubAssets() }, stubDeps('', recording))
    await world.ready
    expect(ctx.vm).toBeInstanceOf(QemuLocalWorld)
    expect(ctx.vm.descriptor.provider).toBe('qemu-local')
    expect(ctx.vm.descriptor.isolation).toBe('full')
    expect(ctx.vm.descriptor.hostHardened).toBe(false)
    expect(ctx.vm.descriptor.readyMs).toBeGreaterThanOrEqual(0)
    await expect(ctx.vm.ping(2_000)).resolves.toBeGreaterThanOrEqual(0)
    await ctx.fiber.dispose()
    await expect(recording.current?.exit).resolves.toEqual({ code: 0, signal: null })
  })

  it('refuses seam access before the world settles', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, { assetsDir: stubAssets() }, stubDeps('hang', recording))
    expect(() => world.descriptor).toThrow('the world has not settled')
    await ctx.fiber.dispose()
  })

  it('fails the boot closed on missing assets', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, { assetsDir: join(tmpdir(), 'dsh-vm-absent-') }, stubDeps('', recording))
    await expect(world.ready).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('forwards the full seam surface with every config field set', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, {
      assetsDir: stubAssets(),
      accel: 'tcg',
      memoryMiB: 128,
      cpus: 1,
      readyTimeoutMs: 10_000,
      shutdownTimeoutMs: 3_000,
      sandbox: 'off',
    }, stubDeps('', recording))
    await world.ready
    expect(world.descriptor.accel).toBe('tcg')
    expect(world.descriptor.memoryMiB).toBe(128)
    expect(world.descriptor.cpus).toBe(1)
    expect(world.descriptor.pid).toBe(recording.current?.child.pid)
    const exec = await world.exec(['echo', 'hi'])
    expect(exec.code === 0).toBe(true)
    expect(exec.stdout.toString('utf8')).toBe('echo hi')
    const spawned = await world.spawn(['cat'])
    expect(spawned.pid).toBe(4242)
    const chunks: Buffer[] = []
    const stop = spawned.onOutput((_stream, chunk) => { chunks.push(chunk) })
    spawned.writeStdin('ignored-by-stub')
    spawned.closeStdin()
    await spawned.signal('SIGTERM')
    await spawned.exit
    stop()
    expect(Buffer.concat(chunks).toString('utf8')).toBe('cat')
    expect(await world.fs.stat('/x')).toMatchObject({ kind: 'file', size: 1 })
    expect((await world.fs.readFile('/x')).toString('utf8')).toBe('x')
    expect(await world.fs.list('/x')).toEqual([{ name: 'a', kind: 'file' }])
    await world.fs.mkdir('/x', { recursive: true })
    await world.fs.unlink('/x')
    await world.fs.rmdir('/x')
    await world.fs.rename('/x', '/y')
    const exited = new Promise<void>((resolve) => { void world.exit.then(() => { resolve() }) })
    await ctx.fiber.dispose()
    await exited
  }, 20_000)

  it('falls back to the package default assets directory when none is configured', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, { readyTimeoutMs: 500 }, stubDeps('exit-now', recording))
    await expect(world.ready).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('boots through the plugin path with Service.init settling the handshake', async () => {
    const ctx = new Context()
    // The plugin path has no deps seam, so point `qemuBin` at an executable
    // copy of the stub: the service spawns it exactly as a real world would.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-assets-'))
    writeFileSync(join(dir, 'vmlinuz-virt'), 'kernel')
    writeFileSync(join(dir, 'initramfs.cpio.gz'), 'initrd')
    const stub = join(dir, 'qemu-stub')
    writeFileSync(stub, `#!/usr/bin/env node\n${readFileSync(stubPath, 'utf8')}`, { mode: 0o755 })
    await ctx.plugin(QemuLocalWorld, { assetsDir: dir, qemuBin: stub, readyTimeoutMs: 10_000 })
    expect(ctx.vm.descriptor.provider).toBe('qemu-local')
    await expect(ctx.vm.ping(2_000)).resolves.toBeGreaterThanOrEqual(0)
    await ctx.fiber.dispose()
  })

  it('fails the plugin load closed when the world cannot boot', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(QemuLocalWorld, { assetsDir: join(tmpdir(), 'dsh-vm-absent-'), readyTimeoutMs: 5_000 })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
