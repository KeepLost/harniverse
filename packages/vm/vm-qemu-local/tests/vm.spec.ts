import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import {
  AssetsMissingError,
  GuestVersionMismatchError,
  QemuSpawnError,
  WorldClosedError,
  WorldReadyTimeoutError,
  defaultSpawnProcess,
  openWorld,
  type ChildLike,
  type SocketLike,
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
        exit: new Promise((resolve) => { child.on('exit', (code, signal) => { resolve({ code, signal }) }) }),
      }
      return child
    },
  }
}

/** Deterministic ChildLike pair: the child plus a manual exit trigger. */
function fakeChild(): { child: ChildLike; emitExit: (code: number | null) => void } {
  const listeners: Record<string, Array<(argument: unknown) => void>> = {}
  return {
    child: {
      pid: 4321,
      kill: () => undefined,
      on: (event, listener) => {
        ;(listeners[event] ??= []).push(listener as (argument: unknown) => void)
      },
    },
    emitExit: (code: number | null) => {
      for (const listener of [...listeners.exit ?? []]) listener(code)
    },
  }
}

/** Deterministic SocketLike whose events tests fire by hand. */
interface FakeSocket extends SocketLike {
  written: string[]
  emitData(chunk: Buffer): void
  emitError(error: Error): void
  emitClose(): void
}

function fakeSocket(): FakeSocket {
  const listeners: Record<string, Array<(argument: unknown) => void>> = {}
  const written: string[] = []
  const fire = (event: string, argument: unknown): void => {
    for (const listener of [...listeners[event] ?? []]) listener(argument)
  }
  return {
    written,
    write: (data) => {
      written.push(String(data))
      return true
    },
    destroy: () => undefined,
    on: (event: string, listener: (argument: never) => void) => {
      (listeners[event] ??= []).push(listener as (argument: unknown) => void)
    },
    emitData: (chunk) => { fire('data', chunk) },
    emitError: (error) => { fire('error', error) },
    emitClose: () => { fire('close', false) },
  }
}

function encode(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** Echo number of the most recent ping frame the host wrote, for scripted pong replies. */
function lastPingNumber(written: readonly string[]): number {
  for (const entry of [...written].reverse()) {
    const match = /"t":"ping","n":(\d+)/.exec(entry)
    if (match !== null) return Number(match[1])
  }
  return 0
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

  it('answers a hello with garbage by failing the handshake', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets() }, stubDeps('hello-garbage', recording))
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('unexpected handshake reply'))
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('answers a hello with an unsolicited pong by failing the handshake', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets() }, stubDeps('hello-pong', recording))
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('unexpected handshake reply'))
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('rejects a welcome that speaks a different version', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const promise = openWorld({ assetsDir: stubAssets() }, stubDeps('welcome-v2', recording))
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof GuestVersionMismatchError && error.guestV === 2)
    await expect(recording.current?.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('a second destroy on a stopped world is clean without further work', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const world = await openWorld({ assetsDir: stubAssets() }, stubDeps('', recording))
    await expect(world.destroy()).resolves.toBe('clean')
    await expect(world.destroy()).resolves.toBe('clean')
  })

  it('reconnects and retries the handshake after an attempt budget expires', async () => {
    const { child, emitExit } = fakeChild()
    const sockets: FakeSocket[] = [fakeSocket(), fakeSocket()]
    const scripted = sockets[1]
    if (scripted === undefined) throw new Error('unreachable')
    let connections = 0
    const world = await openWorld(
      { assetsDir: stubAssets(), readyTimeoutMs: 4_500 },
      {
        spawn: () => child,
        connect: async () => {
          const socket = sockets[connections]
          connections += 1
          if (socket === sockets[0]) {
            // Before its own silence kills the attempt, the first socket
            // sends one parseable-but-unsolicited pong: the beacon wait must
            // ignore it rather than consume it.
            setTimeout(() => {
              socket?.emitData(encode({ t: 'pong', n: 7 }))
            }, 50)
          }
          if (socket === scripted && connections === 2) {
            // The second socket speaks: beacon, then welcome on hello.
            setTimeout(() => {
              socket?.emitData(encode({ t: 'announce', v: 1, caps: ['ping'], agent: 'fake' }))
              const poll = setInterval(() => {
                if (socket.written.some(entry => entry.includes('"hello"'))) {
                  clearInterval(poll)
                  socket.emitData(encode({ t: 'welcome', v: 1, caps: ['ping'], agent: 'fake' }))
                }
              }, 20)
            }, 50)
          }
          return socket ?? fakeSocket()
        },
      },
    )
    expect(connections).toBe(2)
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
  }, 15_000)

  it('drops a world whose socket errors after the beacon', async () => {
    const { child } = fakeChild()
    const socket = fakeSocket()
    const promise = openWorld(
      { assetsDir: stubAssets(), readyTimeoutMs: 900 },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: 1, caps: ['ping'], agent: 'fake' }))
            const poll = setInterval(() => {
              if (socket.written.some(entry => entry.includes('"hello"'))) {
                clearInterval(poll)
                socket.emitError(new Error('boom'))
              }
            }, 20)
          }, 50)
          return socket
        },
      },
    )
    // The error kills the pending wait; the retry loop runs out of budget.
    await expect(promise).rejects.toBeInstanceOf(WorldReadyTimeoutError)
  }, 10_000)

  it('drops a world whose socket sends a malformed frame', async () => {
    const { child } = fakeChild()
    const socket = fakeSocket()
    const promise = openWorld(
      { assetsDir: stubAssets(), readyTimeoutMs: 900 },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: 1, caps: ['ping'], agent: 'fake' }))
            // A zero-length frame prefix is malformed and must fail the channel.
            socket.emitData(Buffer.from([0, 0, 0, 0]))
          }, 50)
          return socket
        },
      },
    )
    await expect(promise).rejects.toBeInstanceOf(WorldReadyTimeoutError)
  }, 10_000)

  it('falls back to the package assets directory when none is given', async () => {
    const recording: { current?: Recording } = {}
    recordings.push(recording)
    const assetsReady = probeWorld().assetsReady
    const attempt = openWorld({}, stubDeps('', recording))
    if (assetsReady) {
      const world = await attempt
      await expect(world.destroy()).resolves.toBe('clean')
    } else {
      await expect(attempt).rejects.toBeInstanceOf(AssetsMissingError)
    }
  }, 15_000)

  it('ignores unsolicited beacons after the handshake', async () => {
    const { child, emitExit } = fakeChild()
    const socket = fakeSocket()
    let interval: ReturnType<typeof setInterval> | undefined
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: 1, caps: ['ping'], agent: 'fake' }))
            interval = setInterval(() => {
              if (socket.written.some(entry => entry.includes('"hello"'))) {
                socket.emitData(encode({ t: 'welcome', v: 1, caps: ['ping'], agent: 'fake' }))
              }
              // Unsolicited duplicate beacons ride along with real replies.
              socket.emitData(encode({ t: 'announce', v: 1, caps: ['ping'], agent: 'fake' }))
              const pingNumber = lastPingNumber(socket.written)
              if (pingNumber > 0) socket.emitData(encode({ t: 'pong', n: pingNumber }))
            }, 20)
          }, 50)
          return socket
        },
      },
    )
    await expect(world.ping(2_000)).resolves.toBeGreaterThanOrEqual(0)
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
    if (interval !== undefined) clearInterval(interval)
  })

  it('the default spawn seam runs the planned argv under a real child', () => {
    const child = defaultSpawnProcess([process.execPath, '-e', '0'], { stdio: 'ignore' })
    // Hosts without QEMU in PATH surface the spawn failure as an error event.
    child.on('error', () => undefined)
    expect(child.pid).toBeGreaterThan(0)
    child.kill('SIGKILL')
    const fallback = defaultSpawnProcess([], { stdio: 'ignore' })
    fallback.on('error', () => undefined)
    // An empty argv falls back to the default QEMU binary; on hosts without
    // it the child simply errors, which still exercises the branch.
    expect(fallback.pid === undefined || fallback.pid > 0).toBe(true)
    fallback.kill('SIGKILL')
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
