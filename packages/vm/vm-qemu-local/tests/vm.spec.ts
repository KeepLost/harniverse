import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AssetsMissingError,
  GuestVersionMismatchError,
  QemuSpawnError,
  WorldClosedError,
  WorldReadyTimeoutError,
  openWorld,
  type ChildLike,
  type VmDeps,
} from '../src/vm.ts'

const stubPath = fileURLToPath(new URL('./qemu-stub.mjs', import.meta.url))

interface Recording {
  child: ChildProcess
  exit: Promise<{ code: number | null; signal: string | null }>
}

/** Real-spawn the stub binary in place of QEMU, recording the child for assertions. */
function stubDeps(mode: string, recording: { current?: Recording }, onSpawn?: () => void): VmDeps {
  return {
    spawn: (argv, options): ChildLike => {
      onSpawn?.()
      const [, ...rest] = argv
      const child = spawn(process.execPath, [stubPath, ...rest], { ...options, env: { ...process.env, DSH_STUB_MODE: mode } })
      recording.current = {
        child,
        exit: new Promise(resolve => child.on('exit', (code, signal) => { resolve({ code, signal }) })),
      }
      return child
    },
  }
}

function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-assets-'))
  writeFileSync(join(dir, 'vmlinuz-virt'), 'kernel')
  writeFileSync(join(dir, 'initramfs.cpio.gz'), 'initrd')
  return dir
}

const recordings: { current?: Recording }[] = []

afterEach(() => {
  // Every test's child must have exited before the suite moves on.
  for (const recording of recordings.splice(0)) {
    recording.current?.child.kill('SIGKILL')
  }
})

describe('vm-qemu-local world lifecycle over a real control socket', () => {
  it('boots, handshakes, answers ping, and shuts down cleanly', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const world = await openWorld({ assetsDir: stubAssets(), readyTimeoutMs: 10_000 }, stubDeps('', recording))
    expect(world.descriptor.readyMs).toBeGreaterThanOrEqual(0)
    await expect(world.ping(2_000)).resolves.toBeGreaterThanOrEqual(0)
    await expect(world.destroy()).resolves.toBe('clean')
    await expect(recording.current?.exit).resolves.toEqual({ code: 0, signal: null })
  })

  it('surfaces a guest version rejection as a typed error and kills the child', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets() }, stubDeps('reject-version', recording))
    await expect(promise).rejects.toBeInstanceOf(GuestVersionMismatchError)
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('times out a silent guest within the ready budget', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets(), readyTimeoutMs: 700 }, stubDeps('hang', recording))
    await expect(promise).rejects.toBeInstanceOf(WorldReadyTimeoutError)
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('fails fast when the child exits before any control socket appears', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets(), readyTimeoutMs: 5_000 }, stubDeps('exit-now', recording))
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('exited before handshake'))
    await expect(recording.current?.exit).resolves.toMatchObject({ code: 0, signal: null })
  })

  it('times out a live guest that never binds the control socket', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets(), readyTimeoutMs: 600 }, stubDeps('no-bind', recording))
    await expect(promise).rejects.toBeInstanceOf(WorldReadyTimeoutError)
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('fails closed before spawning when assets are missing', async () => {
    let spawned = false
    const deps = stubDeps('', {}, () => { spawned = true })
    await expect(openWorld({ assetsDir: mkdtempSync(join(tmpdir(), 'dsh-vm-empty-')) }, deps))
      .rejects.toBeInstanceOf(AssetsMissingError)
    expect(spawned).toBe(false)
  })

  it('surfaces an unspawnable binary as a typed error', async () => {
    await expect(openWorld({ assetsDir: stubAssets(), qemuBin: '/nonexistent-qemu-bin' })).rejects.toBeInstanceOf(QemuSpawnError)
  })

  it('falls back to SIGKILL when the guest ignores shutdown', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const world = await openWorld({ assetsDir: stubAssets(), shutdownTimeoutMs: 400 }, stubDeps('ignore-shutdown', recording))
    await expect(world.destroy()).resolves.toBe('killed')
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('rejects ping after the world stopped', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const world = await openWorld({ assetsDir: stubAssets() }, stubDeps('', recording))
    await world.destroy()
    await expect(world.ping()).rejects.toBeInstanceOf(WorldClosedError)
  })

  it('rejects the handshake when qemu exits after binding the control socket', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    // The stub exits instantly; an independent silent server keeps the socket
    // bound, so the host connects and then observes the child's exit at
    // handshake instead of a reply.
    const { createServer, connect: netConnect } = await import('node:net')
    const runDir = mkdtempSync(join(tmpdir(), 'dsh-vm-run-'))
    const socketPath = join(runDir, 'ctl.sock')
    const server = createServer(() => {})
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
    const deps = stubDeps('exit-now', recording)
    const promise = openWorld(
      { assetsDir: stubAssets(), readyTimeoutMs: 5_000 },
      {
        ...deps,
        connect: async () =>
          await new Promise((resolve, reject) => {
            const socket = netConnect(socketPath)
            socket.once('connect', () => { resolve(socket) })
            socket.once('error', (error) => { reject(error) })
          }),
      },
    )
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('exited before handshake'))
    await expect(recording.current?.exit).resolves.toMatchObject({ code: 0, signal: null })
    server.close()
  })
})
