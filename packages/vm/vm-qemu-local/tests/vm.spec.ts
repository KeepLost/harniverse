import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import { EgressDeniedError } from '../src/egress.ts'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
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
    destroy: () => { fire('close', false) },
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


/** Assets plus a staged executable sandbox wrapper. */
function sandboxAssets(): string {
  const dir = stubAssets()
  const wrap = join(dir, 'qemu-wrap')
  writeFileSync(wrap, '#!/bin/sh\ntrue\n')
  chmodSync(wrap, 0o755)
  return dir
}

/** Fake socket that beacons, then answers hello with a welcome. */
function welcomeSocket(): FakeSocket {
  const socket = fakeSocket()
  setTimeout(() => {
    socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
    const poll = setInterval(() => {
      if (socket.written.some(entry => entry.includes('"hello"'))) {
        clearInterval(poll)
        socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
      }
    }, 10)
  }, 20)
  return socket
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
    const promise = openWorld({ assetsDir: stubAssets() }, stubDeps('welcome-v3', recording))
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof GuestVersionMismatchError && error.guestV === 3)
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
              socket?.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
              const poll = setInterval(() => {
                if (socket.written.some(entry => entry.includes('"hello"'))) {
                  clearInterval(poll)
                  socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
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
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
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
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
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
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
            interval = setInterval(() => {
              if (socket.written.some(entry => entry.includes('"hello"'))) {
                socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
              }
              // Unsolicited duplicate beacons ride along with real replies.
              socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
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

  it('drives one exec end to end through the world handle', async () => {
    const { child, emitExit } = fakeChild()
    const socket = fakeSocket()
    let phase = 0
    let interval: ReturnType<typeof setInterval> | undefined
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
            let helloAnswered = false
            interval = setInterval(() => {
              if (!helloAnswered && socket.written.some(entry => entry.includes('"t":"hello"'))) {
                socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
                helloAnswered = true
                return
              }
              if (phase === 0 && socket.written.some(entry => entry.includes('"t":"exec"'))) {
                socket.emitData(encode({ t: 'exec.started', id: 1, pid: 9 }))
                phase = 1
                return
              }
              if (phase === 1) {
                socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
                socket.emitData(encode({ t: 'exec.out', id: 1, s: 'o', d: Buffer.from('wired-in').toString('base64') }))
                phase = 2
                return
              }
              if (phase === 2) {
                socket.emitData(encode({ t: 'exec.exit', id: 1, code: 0 }))
                phase = 3
              }
            }, 10)
          }, 50)
          return socket
        },
      },
    )
    const result = await world.exec(['/bin/cat'], { stdin: 'wired-in' })
    expect(result.code).toBe(0)
    expect(result.stdout.toString('utf8')).toBe('wired-in')
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
    if (interval !== undefined) clearInterval(interval)
  })

  it('round-trips one fs read through the world handle', async () => {
    const { child, emitExit } = fakeChild()
    const socket = fakeSocket()
    let answered = false
    let interval: ReturnType<typeof setInterval> | undefined
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
            let helloAnswered = false
            interval = setInterval(() => {
              if (!helloAnswered && socket.written.some(entry => entry.includes('"t":"hello"'))) {
                socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
                helloAnswered = true
                return
              }
              if (!answered && socket.written.some(entry => entry.includes('"op":"read"'))) {
                socket.emitData(encode({ t: 'fs.ok', id: 1, d: Buffer.from('guest-bytes').toString('base64') }))
                answered = true
              }
            }, 10)
          }, 50)
          return socket
        },
      },
    )
    await expect(world.fs.readFile('/tmp/f')).resolves.toEqual(Buffer.from('guest-bytes'))
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
    if (interval !== undefined) clearInterval(interval)
  })

  it('drops a live exec when the control port closes', async () => {
    const { child, emitExit } = fakeChild()
    const socket = fakeSocket()
    let started = false
    let interval: ReturnType<typeof setInterval> | undefined
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
            let helloAnswered = false
            interval = setInterval(() => {
              if (!helloAnswered && socket.written.some(entry => entry.includes('"t":"hello"'))) {
                socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
                helloAnswered = true
                return
              }
              if (!started && socket.written.some(entry => entry.includes('"t":"exec"'))) {
                socket.emitData(encode({ t: 'exec.started', id: 1, pid: 8 }))
                started = true
              }
            }, 10)
          }, 50)
          return socket
        },
      },
    )
    const handle = await world.spawn(['/bin/sleep', '30'])
    socket.emitClose()
    await expect(handle.exit).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('control port closed'))
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
    if (interval !== undefined) clearInterval(interval)
  })

  it('rejects exec, spawn, and fs calls after the world stopped', async () => {
    const { child, emitExit } = fakeChild()
    const socket = fakeSocket()
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: () => child,
        connect: async () => {
          setTimeout(() => {
            socket.emitData(encode({ t: 'announce', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
          }, 50)
          const interval = setInterval(() => {
            if (socket.written.some(entry => entry.includes('"t":"hello"'))) {
              socket.emitData(encode({ t: 'welcome', v: PROTOCOL_VERSION, caps: ['ping', 'exec', 'fs'], agent: 'fake' }))
              clearInterval(interval)
            }
          }, 10)
          return socket
        },
      },
    )
    emitExit(0)
    await expect(world.destroy()).resolves.toBe('clean')
    await expect(world.exec(['/bin/true'])).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('already stopped'))
    await expect(world.spawn(['/bin/true'])).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('already stopped'))
    await expect(world.fs.readFile('/tmp/f')).rejects.toSatisfy((error: unknown) =>
      error instanceof WorldClosedError && error.message.includes('already stopped'))
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

describe('vm-qemu-local sandbox supervision', () => {
  it('wraps the child under a staged wrapper and hands over the scratch directory on root hosts', async () => {
    const { child, emitExit } = fakeChild()
    const seenArgv: string[][] = []
    const chowns: Array<[string, number, number]> = []
    const world = await openWorld(
      { assetsDir: sandboxAssets() },
      {
        spawn: (argv) => {
          seenArgv.push([...argv])
          return child
        },
        connect: async () => welcomeSocket(),
        euid: () => 0,
        chown: async (path, uid, gid) => { chowns.push([path, uid, gid]) },
      },
    )
    expect(world.descriptor.sandboxed).toBe(true)
    const wrapped = seenArgv[0] ?? []
    expect(wrapped[0]).toMatch(/qemu-wrap$/)
    expect(wrapped[1]).toBe('--scratch')
    const scratch = wrapped[2] ?? ''
    expect(wrapped[3]).toBe('--')
    expect(wrapped[4]).toBe('qemu-system-x86_64')
    expect(chowns).toEqual([[scratch, 65534, 65534]])
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
  }, 10_000)

  it('spawns QEMU directly when no wrapper is staged', async () => {
    const { child, emitExit } = fakeChild()
    const seenArgv: string[][] = []
    const chowns: Array<[string, number, number]> = []
    const world = await openWorld(
      { assetsDir: stubAssets() },
      {
        spawn: (argv) => {
          seenArgv.push([...argv])
          return child
        },
        connect: async () => welcomeSocket(),
        euid: () => 0,
        chown: async (path, uid, gid) => { chowns.push([path, uid, gid]) },
      },
    )
    expect(world.descriptor.sandboxed).toBe(false)
    expect(seenArgv[0]?.[0]).toBe('qemu-system-x86_64')
    expect(chowns).toEqual([])
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
  }, 10_000)

  it('skips the wrapper when sandbox hardening is explicitly disabled', async () => {
    const { child, emitExit } = fakeChild()
    const seenArgv: string[][] = []
    const world = await openWorld(
      { assetsDir: sandboxAssets(), sandbox: 'off' },
      {
        spawn: (argv) => {
          seenArgv.push([...argv])
          return child
        },
        connect: async () => welcomeSocket(),
        euid: () => 0,
        chown: async () => { throw new Error('must not chown') },
      },
    )
    expect(world.descriptor.sandboxed).toBe(false)
    expect(seenArgv[0]?.[0]).toBe('qemu-system-x86_64')
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
  }, 10_000)

  it('treats a host without geteuid as unprivileged', async () => {
    const original = process.geteuid
    Object.defineProperty(process, 'geteuid', { value: undefined, configurable: true })
    const { child, emitExit } = fakeChild()
    try {
      const world = await openWorld(
        { assetsDir: sandboxAssets() },
        {
          spawn: () => child,
          connect: async () => welcomeSocket(),
          chown: async () => { throw new Error('must not chown') },
        },
      )
      expect(world.descriptor.sandboxed).toBe(true)
      const destroyed = world.destroy()
      setTimeout(() => { emitExit(0) }, 20)
      await expect(destroyed).resolves.toBe('clean')
    } finally {
      Object.defineProperty(process, 'geteuid', { value: original, configurable: true })
    }
  }, 10_000)

  it('removes the run directory when boot-asset staging fails', async () => {
    const runDirs: string[] = []
    await expect(openWorld(
      { assetsDir: sandboxAssets() },
      {
        spawn: () => { throw new Error('must not spawn') },
        connect: async () => welcomeSocket(),
        euid: () => 0,
        chown: async () => {},
        copyFile: async () => { throw new Error('disk full') },
        mkdtemp: async (prefix) => {
          const dir = mkdtempSync(prefix)
          runDirs.push(dir)
          return dir
        },
      },
    )).rejects.toThrow('disk full')
    expect(existsSync(runDirs[0] ?? '')).toBe(false)
  }, 10_000)

  it('keeps the wrapped command line but skips ownership handover when not root', async () => {
    const { child, emitExit } = fakeChild()
    const seenArgv: string[][] = []
    const world = await openWorld(
      { assetsDir: sandboxAssets() },
      {
        spawn: (argv) => {
          seenArgv.push([...argv])
          return child
        },
        connect: async () => welcomeSocket(),
        euid: () => 1000,
        chown: async () => { throw new Error('must not chown') },
      },
    )
    expect(world.descriptor.sandboxed).toBe(true)
    expect(seenArgv[0]?.[0]).toMatch(/qemu-wrap$/)
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
  }, 10_000)
})

describe('vm-qemu-local egress wiring', () => {
  it('denies egress by default and closes the relay with the world', async () => {
    const { child, emitExit } = fakeChild()
    const world = await openWorld(
      { assetsDir: stubAssets() },
      { spawn: () => child, connect: async () => welcomeSocket() },
    )
    await expect(world.egress.open('example.com', 443)).rejects.toBeInstanceOf(EgressDeniedError)
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
    await expect(world.egress.open('example.com', 443)).rejects.toBeInstanceOf(EgressDeniedError)
  }, 10_000)

  it('surfaces a refused approved dial as EgressConnectError', async () => {
    const { child, emitExit } = fakeChild()
    const world = await openWorld(
      { assetsDir: stubAssets(), egressPolicy: () => true },
      { spawn: () => child, connect: async () => welcomeSocket() },
    )
    if (process.platform === 'win32') return
    await expect(world.egress.open('127.0.0.1', 1)).rejects.toMatchObject({ name: 'EgressConnectError' })
    const destroyed = world.destroy()
    setTimeout(() => { emitExit(0) }, 20)
    await expect(destroyed).resolves.toBe('clean')
  }, 10_000)
})
