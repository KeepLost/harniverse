/** RemoteProcesses allocation bounds, dispatch routing, terminal control, and cleanup joins over fake handles. */
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteProcesses } from '../src/helper-processes.ts'

const ordinary = { argv: ['/bin/worker'], cwd: '/tmp', graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }
const terminalSpec = { argv: ['/bin/sh'], cwd: '/tmp', graceMs: 5000, terminal: { rows: 24, cols: 80 } }

interface Gate { promise: Promise<void>; release: () => void }

const gate = (): Gate => {
  const gated: PromiseWithResolvers<void> = Promise.withResolvers()
  return { promise: gated.promise, release: () => { gated.resolve() } }
}

class FakeHandle {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly pid = 4242
  private readonly settled: PromiseWithResolvers<void> = Promise.withResolvers()
  readonly done = this.settled.promise.then(() => ({ exitCode: 0, signal: null }))
  terminate = vi.fn(async () => { this.settled.resolve() })
  readonly collected = {
    stdout: { readFrom: (offset: number) => `stdout@${offset}` },
    stderr: { readFrom: (offset: number) => `stderr@${offset}` },
  }
  waitForExit = vi.fn(async () => true)
}

class FakeTerminal {
  readonly output = new PassThrough()
  readonly pid = 4243
  readonly done = Promise.resolve({ exitCode: 0, signal: null })
  write = vi.fn(async () => {})
  inspectForeground = vi.fn(async (): Promise<{ processGroupId: number; inputWaiting: boolean } | undefined> =>
    ({ processGroupId: 7, inputWaiting: false }))
  signalForeground = vi.fn(() => null)
  resize = vi.fn(async () => {})
  terminate = vi.fn(async () => {})
}

interface Harness {
  remote: RemoteProcesses
  ordinary: FakeHandle[]
  terminals: FakeTerminal[]
  spawnGate: Gate | undefined
  dispose: () => Promise<void>
}

const setup = (options: { spawnGate?: Gate } = {}): Harness => {
  const handles: FakeHandle[] = []
  const terminals: FakeTerminal[] = []
  const spawn = vi.fn(() => {
    const handle = new FakeHandle()
    handles.push(handle)
    return handle
  })
  const spawnTerminal = vi.fn(async () => {
    if (options.spawnGate) await options.spawnGate.promise
    const handle = new FakeTerminal()
    terminals.push(handle)
    return handle
  })
  const ctx = { subprocess: { spawn, spawnTerminal } } as unknown as Context
  return {
    remote: new RemoteProcesses(ctx), ordinary: handles, terminals, spawnGate: options.spawnGate,
    dispose: async () => {
      await new RemoteProcesses(ctx).close().catch(() => {})
      for (const handle of handles) {
        handle.stdout.destroy(); handle.stderr.destroy(); handle.stdin.destroy()
      }
      for (const handle of terminals) handle.output.destroy()
    },
  }
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const test of harnesses.splice(0)) {
    await test.remote.close().catch(() => {})
    await test.dispose()
  }
})

const begin = (options?: { spawnGate?: Gate }): Harness => {
  const test = setup(options)
  harnesses.push(test)
  return test
}

const spawnOrdinary = async (test: Harness, spec: Record<string, unknown> = ordinary) => {
  const spawned = await test.remote.spawn(spec, new AbortController().signal)
  return { id: spawned.id, handle: test.ordinary.at(-1)! }
}

describe('RemoteProcesses spawn allocation', () => {
  it('maps wire specs into local spawns with env and limit normalization', async () => {
    const test = begin()
    const first = await spawnOrdinary(test, {
      ...ordinary, argv: ['/bin/first'], env: { KEEP: 'yes', DROP: null },
      limits: { maxMemoryBytes: 1024 * 1024 },
    })
    expect(first.handle).toBeDefined()
    const second = await test.remote.spawn({ ...ordinary, argv: ['/bin/second'] }, new AbortController().signal)
    expect(second.pid).toBe(4242)
    const secondHandle = test.ordinary.at(-1)!
    expect(Object.keys(secondHandle.collected)).toEqual(['stdout', 'stderr'])
  })

  it('rejects inherited stdio and capacity overflow', async () => {
    const test = begin()
    await expect(test.remote.spawn({ ...ordinary, stdio: { ...ordinary.stdio, stdout: 'inherit' } }, new AbortController().signal))
      .rejects.toThrow('cannot inherit helper stdio')
    await expect(test.remote.spawn({ ...ordinary, stdio: { ...ordinary.stdio, stderr: 'inherit' } }, new AbortController().signal))
      .rejects.toThrow('cannot inherit helper stdio')
    const spawned: { id: string }[] = []
    for (let index = 0; index < 32; index += 1) spawned.push(await test.remote.spawn(ordinary, new AbortController().signal))
    expect(spawned).toHaveLength(32)
    await expect(test.remote.spawn(ordinary, new AbortController().signal)).rejects.toThrow('SSH process capacity exhausted')
    await expect(test.remote.spawn(ordinary, AbortSignal.abort(new Error('no room')))).rejects.toThrow('no room')
  })

  it('rolls back terminal allocations aborted or closed mid-spawn', async () => {
    const aborted = begin({ spawnGate: gate() })
    const controller = new AbortController()
    const spawned = aborted.remote.spawn(terminalSpec, controller.signal)
    controller.abort(new Error('too late'))
    aborted.spawnGate!.release()
    await expect(spawned).rejects.toThrow('SSH process allocation cancelled')

    const closed = begin({ spawnGate: gate() })
    const allocation = closed.remote.spawn(terminalSpec, new AbortController().signal)
    const closing = closed.remote.close()
    closed.spawnGate!.release()
    await expect(allocation).rejects.toThrow('SSH process allocation cancelled')
    await closing
    await expect(closed.remote.spawn(ordinary, new AbortController().signal)).rejects.toThrow('SSH process capacity exhausted')
  })
})

describe('RemoteProcesses dispatch routing', () => {
  it('validates ids, argument shapes, and unknown handles', async () => {
    const test = begin()
    const { id } = await spawnOrdinary(test)
    await expect(test.remote.dispatch('process.state', { id: 'not-a-uuid' }, new AbortController().signal)).rejects.toThrow()
    await expect(test.remote.dispatch('process.state', { id, extra: true }, new AbortController().signal)).rejects.toThrow()
    await expect(test.remote.dispatch('process.state', { id, data: 'x'.repeat(49 * 1024) }, new AbortController().signal)).rejects.toThrow()
    await expect(test.remote.dispatch('process.state', { id: '00000000-0000-4000-8000-000000000000' }, new AbortController().signal))
      .rejects.toThrow('Unknown SSH process handle')
  })

  it('reports state, outcomes, and collected output snapshots', async () => {
    const test = begin()
    const { id } = await spawnOrdinary(test)
    const pending = await test.remote.dispatch('process.state', { id }, new AbortController().signal) as {
      outcome: unknown
      collected: { stdout: string; stderr: string }
    }
    expect(pending.outcome).toBeNull()
    expect(pending.collected).toEqual({ stdout: 'stdout@0', stderr: 'stderr@0' })
    const released = await test.remote.dispatch('process.terminate', { id }, new AbortController().signal)
    expect(released).toBeNull()
    await expect(test.remote.dispatch('process.write', { id, data: Buffer.alloc(1).toString('base64') }, new AbortController().signal))
      .rejects.toThrow('SSH process is closing')
    await test.remote.dispatch('process.release', { id }, new AbortController().signal)
    await expect(test.remote.dispatch('process.state', { id }, new AbortController().signal)).rejects.toThrow('Unknown SSH process handle')

    const terminal = await test.remote.spawn({ ...terminalSpec, env: { KEEP: 'yes', DROP: null } }, new AbortController().signal)
    const handle = test.terminals.at(-1)!
    expect(handle).toBeDefined()
    const state = await test.remote.dispatch('process.state', { id: terminal.id }, new AbortController().signal) as {
      outcome: unknown
      collected: { stdout: unknown; stderr: unknown }
    }
    expect(state.collected).toEqual({ stdout: undefined, stderr: undefined })
  })

  it('rethrows recorded handle failures for observation operations', async () => {
    const failing = new FakeHandle()
    const broken = Object.assign(failing, { done: Promise.reject(new Error('spawn exploded')) })
    const ctx = { subprocess: { spawn: vi.fn(() => broken), spawnTerminal: vi.fn() } } as unknown as Context
    const remote = new RemoteProcesses(ctx)
    const { id } = await remote.spawn(ordinary, new AbortController().signal)
    await new Promise((resolve) => { setImmediate(resolve) })
    await expect(remote.dispatch('process.state', { id }, new AbortController().signal)).rejects.toThrow('spawn exploded')
    await expect(remote.dispatch('process.wait', { id }, new AbortController().signal)).rejects.toThrow('spawn exploded')
    await remote.dispatch('process.terminate', { id }, new AbortController().signal)
    await remote.close().catch(() => {})
  })

  it('wraps non-Error handle failures as errors', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers the non-Error done rejection branch
    const plain = Object.assign(new FakeHandle(), { done: Promise.reject('plain failure') })
    const ctx = { subprocess: { spawn: vi.fn(() => plain), spawnTerminal: vi.fn() } } as unknown as Context
    const remote = new RemoteProcesses(ctx)
    const { id } = await remote.spawn(ordinary, new AbortController().signal)
    await new Promise((resolve) => { setImmediate(resolve) })
    await expect(remote.dispatch('process.state', { id }, new AbortController().signal)).rejects.toThrow('plain failure')
    await remote.close().catch(() => {})
  })

  it('waits through the requested signal for ordinary handles and terminates terminals', async () => {
    const test = begin()
    const { id, handle } = await spawnOrdinary(test)
    const controller = new AbortController()
    expect(await test.remote.dispatch('process.wait', { id }, controller.signal)).toBe(true)
    expect(handle.waitForExit).toHaveBeenCalledWith(controller.signal)

    const terminal = await test.remote.spawn(terminalSpec, new AbortController().signal)
    expect(await test.remote.dispatch('process.wait', { id: terminal.id }, new AbortController().signal)).toBe(true)
    expect(test.terminals.at(-1)!.terminate).toHaveBeenCalled()
  })
})

describe('RemoteProcesses stream operations', () => {
  it('reads single-reader chunks and refuses missing or mismatched pipes', async () => {
    const test = begin()
    const { id, handle } = await spawnOrdinary(test)
    await expect(test.remote.dispatch('process.read', { id }, new AbortController().signal)).rejects.toThrow('SSH stream already has a reader')
    await expect(test.remote.dispatch('process.read', { id, stream: 'terminal' }, new AbortController().signal)).rejects.toThrow('no requested pipe')
    const first = test.remote.dispatch('process.read', { id, stream: 'stdout' }, new AbortController().signal)
    await expect(test.remote.dispatch('process.read', { id, stream: 'stdout' }, new AbortController().signal)).rejects.toThrow('SSH stream already has a reader')
    handle.stdout.write('payload')
    expect(Buffer.from(await first as string, 'base64').toString()).toBe('payload')
    handle.stdout.end()
    expect(await test.remote.dispatch('process.read', { id, stream: 'stdout' }, new AbortController().signal)).toBeNull()

    const terminal = await test.remote.spawn(terminalSpec, new AbortController().signal)
    await expect(test.remote.dispatch('process.read', { id: terminal.id, stream: 'stdout' }, new AbortController().signal)).rejects.toThrow('no requested pipe')
    test.terminals.at(-1)!.output.write('keys')
    const keys = await test.remote.dispatch('process.read', { id: terminal.id, stream: 'terminal' }, new AbortController().signal) as string
    expect(Buffer.from(keys, 'base64').toString()).toBe('keys')
  })

  it('rejects waiting reads on abort, stream errors, and non-error abort reasons', async () => {
    const test = begin()
    const first = await spawnOrdinary(test)
    const abort = new AbortController()
    const waiting = test.remote.dispatch('process.read', { id: first.id, stream: 'stdout' }, abort.signal)
    abort.abort(new Error('reader left'))
    await expect(waiting).rejects.toThrow('reader left')

    const second = await spawnOrdinary(test)
    const reason = new AbortController()
    const pending = test.remote.dispatch('process.read', { id: second.id, stream: 'stderr' }, reason.signal)
    reason.abort('plain reason')
    await expect(pending).rejects.toThrow('plain reason')

    const third = await spawnOrdinary(test)
    const broken = test.remote.dispatch('process.read', { id: third.id, stream: 'stdout' }, new AbortController().signal)
    test.ordinary.at(-1)!.stdout.emit('error', new Error('pipe burst'))
    await expect(broken).rejects.toThrow('pipe burst')
  })

  it('writes stdin chunks, closes streams, and refuses terminal stdin', async () => {
    const test = begin()
    const { id } = await spawnOrdinary(test)
    await expect(test.remote.dispatch('process.write', { id }, new AbortController().signal)).rejects.toThrow('Missing stdin data')
    const chunks: Buffer[] = []
    const handle = test.ordinary.at(-1)!
    handle.stdin.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    await test.remote.dispatch('process.write', { id, data: Buffer.from('abc').toString('base64') }, new AbortController().signal)
    await test.remote.dispatch('process.write', { id, data: null }, new AbortController().signal)
    expect(Buffer.concat(chunks).toString()).toBe('abc')
    expect(handle.stdin.writableEnded).toBe(true)

    const terminal = await test.remote.spawn(terminalSpec, new AbortController().signal)
    await expect(test.remote.dispatch('process.write', { id: terminal.id, data: Buffer.alloc(1).toString('base64') }, new AbortController().signal))
      .rejects.toThrow('no stdin pipe')
  })

  it('routes terminal control operations and rejects them for ordinary handles', async () => {
    const test = begin()
    const ordinaryId = await spawnOrdinary(test)
    await expect(test.remote.dispatch('terminal.write', { id: ordinaryId.id, data: 'x' }, new AbortController().signal))
      .rejects.toThrow('SSH process is not a terminal')

    const { id } = await test.remote.spawn(terminalSpec, new AbortController().signal)
    const handle = test.terminals.at(-1)!
    await test.remote.dispatch('terminal.write', { id, data: 'dir\n' }, new AbortController().signal)
    await expect(test.remote.dispatch('terminal.write', { id, data: null }, new AbortController().signal)).rejects.toThrow()
    expect(handle.write).toHaveBeenCalledWith('dir\n')
    expect(await test.remote.dispatch('terminal.inspect', { id }, new AbortController().signal)).toEqual({ processGroupId: 7, inputWaiting: false })
    handle.inspectForeground.mockResolvedValue(undefined)
    expect(await test.remote.dispatch('terminal.inspect', { id }, new AbortController().signal)).toBeNull()
    await test.remote.dispatch('terminal.signal', { id, signal: 'SIGINT' }, new AbortController().signal)
    expect(handle.signalForeground).toHaveBeenCalledWith('SIGINT')
    await test.remote.dispatch('terminal.resize', { id, cols: 120, rows: 40 }, new AbortController().signal)
    expect(handle.resize).toHaveBeenCalledWith(120, 40)
    await expect(test.remote.dispatch('terminal.mystery', { id }, new AbortController().signal)).rejects.toThrow('Unsupported SSH process operation: terminal.mystery')
  })
})

describe('RemoteProcesses teardown', () => {
  it('fails the range when a terminated handle never exits', async () => {
    const test = begin()
    const { id } = await spawnOrdinary(test)
    const handle = test.ordinary.at(-1)!
    handle.waitForExit.mockResolvedValue(false)
    await expect(test.remote.dispatch('process.terminate', { id }, new AbortController().signal)).rejects.toThrow('SSH process range did not become quiescent')
  })

  it('aggregates cleanup failures when closing the range', async () => {
    const test = begin()
    await spawnOrdinary(test)
    test.ordinary.at(-1)!.terminate.mockRejectedValue(new Error('terminate refused'))
    await expect(test.remote.close()).rejects.toMatchObject({ name: 'AggregateError', message: 'SSH process cleanup failed' })
  })

  it('surfaces stdin write failures through write acknowledgements', async () => {
    const test = begin()
    const { id } = await spawnOrdinary(test)
    const handle = test.ordinary.at(-1)!
    handle.stdin.destroy()
    const broken = new Writable({
      write: (_chunk, _encoding, callback) => { callback(new Error('disk gone')) },
    })
    broken.on('error', () => {})
    Object.assign(handle, { stdin: broken })
    await expect(test.remote.dispatch('process.write', { id, data: Buffer.from('x').toString('base64') }, new AbortController().signal))
      .rejects.toThrow('disk gone')
    broken.destroy()
  })
})
