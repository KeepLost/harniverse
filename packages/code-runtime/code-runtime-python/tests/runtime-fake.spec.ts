import { EventEmitter, getEventListeners } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingNamespace, CodeRunRequest } from '@deepseek-ai/dsh-code-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { PythonCodeRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'

type ChildFrame = Record<string, unknown>
type Script = (child: FakeChild, frame: ChildFrame) => void

class FakeStream extends EventEmitter {
  ended = false
  throwOnEnd = false
  onWrite?: (text: string) => void

  constructor(readonly writes: string[] = []) {
    super()
  }

  write(text: string): boolean {
    this.writes.push(text)
    this.onWrite?.(text)
    return true
  }

  end(): void {
    if (this.throwOnEnd) throw new Error('stream already closed')
    this.ended = true
  }

  send(value: unknown): void {
    this.emit('data', Buffer.from(`${JSON.stringify(value)}\n`))
  }

  sendRaw(value: string | Buffer): void {
    this.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value))
  }
}

class FakeChild extends EventEmitter {
  readonly input = new FakeStream()
  stdin: FakeStream | null = this.input
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly protocol = new FakeStream(this.input.writes)
  readonly stdio: (string | FakeStream | null)[] = ['ignored', this.stdout, this.stderr, this.protocol]
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  constructor(private readonly script: Script) {
    super()
    this.input.onWrite = (text) => {
      this.script(this, JSON.parse(text) as ChildFrame)
    }
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    if (this.killed) return true
    this.killed = true
    this.signalCode = signal
    this.emit('close', null, signal)
    return true
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }

  fail(error = new Error('child failed')): void {
    this.emit('error', error)
  }
}

function namespace(functions: Record<string, (args: unknown) => unknown>, errorClass = true): CodeBindingNamespace {
  return {
    global: 'tools',
    functions,
    ...errorClass ? { errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } } : {},
  } as CodeBindingNamespace
}

function request(overrides: Partial<CodeRunRequest> = {}): CodeRunRequest {
  return { program: 'return 1', bindings: [], ...overrides }
}

async function setup(config: Config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(PythonCodeRuntime, config)
  return { ctx, fiber, runtime: ctx.codeRuntime as PythonCodeRuntime }
}

function arm(script: Script): () => FakeChild {
  let child!: FakeChild
  spawnMock.mockImplementation(() => {
    child = new FakeChild(script)
    return child as never
  })
  return () => child
}

afterEach(() => {
  spawnMock.mockReset()
  vi.useRealTimers()
})

describe('PythonCodeRuntime deterministic process boundary', () => {
  it('validates every deployment limit and executable guard', async () => {
    const invalidConfigs: [Config, RegExp][] = [
      [{ pythonExecutable: '   ' }, /pythonExecutable/],
      [{ pythonExecutable: 'python\0' }, /pythonExecutable/],
      [{ cpuSeconds: 0 }, /cpuSeconds/],
      [{ maxAddressSpaceMb: 0 }, /maxAddressSpaceMb/],
      [{ maxOutputBytes: 0 }, /maxOutputBytes/],
      [{ maxControlBytes: 0 }, /maxControlBytes/],
      [{ maxWallMs: 0 }, /maxWallMs/],
      [{ maxWallMs: Number.POSITIVE_INFINITY }, /maxWallMs/],
      [{ maxWallMs: 2 ** 31 }, /maxWallMs/],
      [{ maxOutputBytes: 3 }, /maxOutputBytes/],
      [{ maxAddressSpaceMb: Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024)) + 1 }, /maxAddressSpaceMb/],
      [{ maxOutputBytes: 100, maxControlBytes: 1_123 }, /maxControlBytes/],
    ]
    for (const [config, message] of invalidConfigs) {
      const ctx = new Context()
      await expect(ctx.plugin(PythonCodeRuntime, config)).rejects.toThrow(message)
    }
  })

  it('normalizes spawn throws, missing fd3, and child startup errors', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime, {})
    spawnMock.mockImplementation(() => { throw new Error('spawn denied') })
    await expect(ctx.codeRuntime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process could not start' },
    })
    await fiber.dispose()

    const startupFailure = arm((child) => { child.fail() })
    const startupRuntime = await setup()
    await expect(startupRuntime.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process could not start' },
    })
    expect(startupFailure().listenerCount('error')).toBe(0)
    await startupRuntime.fiber.dispose()
  })

  it('covers missing fd3 and initial boot write failures', async () => {
    const missingInput = new FakeChild(() => {})
    missingInput.stdin = null
    spawnMock.mockImplementationOnce(() => missingInput as never)
    const noInput = await setup()
    await expect(noInput.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process control channel unavailable' },
    })
    expect(missingInput.killed).toBe(true)
    await noInput.fiber.dispose()

    const missing = new FakeChild(() => {})
    missing.stdio[3] = null
    spawnMock.mockImplementationOnce(() => missing as never)
    const first = await setup()
    await expect(first.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process control channel unavailable' },
    })
    expect(missing.killed).toBe(true)
    await first.fiber.dispose()

    const throwing = new FakeChild(() => {})
    throwing.input.write = () => { throw new Error('stdin write failed') }
    spawnMock.mockImplementationOnce(() => throwing as never)
    const second = await setup()
    await expect(second.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process control channel unavailable' },
    })
    await second.fiber.dispose()
  })

  it('rejects invalid, duplicate, reserved, and unusable binding descriptors', async () => {
    const { runtime, fiber } = await setup()
    const cases: [CodeBindingNamespace[], RegExp][] = [
      [
        [namespace({}), namespace({})],
        /duplicate binding global/,
      ],
      [[{ global: 'console', functions: {} }], /reserved binding global/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'lambda', memberNameProperty: 'toolName' } }], /error class/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'console', memberNameProperty: 'toolName' } }], /reserved binding global/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'Other', memberNameProperty: 'toolName' } }, { global: 'other', functions: {}, errorClass: { name: 'Other', memberNameProperty: 'otherName' } }], /duplicate injected global/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'Other', memberNameProperty: '' } }], /error member/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'Other', memberNameProperty: 'message' } }], /error member/],
      [[{ global: 'tools', functions: {}, errorClass: { name: 'Other', memberNameProperty: '__value__' } }], /error member/],
    ]
    for (const [bindings, message] of cases) {
      await expect(runtime.run(request({ bindings }))).rejects.toThrow(message)
    }
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.run(request({ bindings: [namespace({}, false)], signal: controller.signal }))).resolves.toEqual({
      logs: [], error: { kind: 'abort', message: 'run aborted' },
    })
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'done', value: 1 })
    })
    await expect(runtime.run(request({ bindings: [namespace({}, false)] }))).resolves.toEqual({ logs: [], value: 1 })
    await fiber.dispose()
  })

  it('reports boot and run frames that exceed the control budget', async () => {
    const bootOverflow = arm(() => {})
    const first = await setup({ maxOutputBytes: 128, maxControlBytes: 1_152 })
    const hugeName = 'functionName'.repeat(200)
    await expect(first.runtime.run(request({ bindings: [namespace({ [hugeName]: async () => 1 })] }))).resolves.toEqual({
      logs: [], error: { kind: 'exception', message: 'binding metadata exceeds configured control limit' },
    })
    expect(bootOverflow().killed).toBe(true)
    await first.fiber.dispose()

    arm((child) => {
      child.protocol.send({ type: 'boot-ack' })
    })
    const second = await setup({ maxOutputBytes: 128, maxControlBytes: 2_048 })
    await expect(second.runtime.run(request({ program: 'x'.repeat(3_000) }))).resolves.toEqual({
      logs: [], error: { kind: 'exception', message: 'program exceeds configured control limit' },
    })
    await second.fiber.dispose()
  })

  it('handles stdout, stderr, logs, lossless values, and output ledger boundaries', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.stdout.emit('data', Buffer.from('ascii'))
        child.stderr.emit('data', Buffer.from('é'))
        child.protocol.send({ type: 'log', text: 'quote\\" slash\\ control\u0001 two-byte é three-byte € four-byte 😀' })
        child.protocol.send({ type: 'done', value: { text: 'value', array: [true, null, 1.5], object: { n: 1 } } })
      }
    })
    const normal = await setup({ maxOutputBytes: 512 })
    await expect(normal.runtime.run(request())).resolves.toEqual({
      logs: ['ascii', 'é', 'quote\\" slash\\ control\u0001 two-byte é three-byte € four-byte 😀'],
      value: { text: 'value', array: [true, null, 1.5], object: { n: 1 } },
    })
    await normal.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.stdout.emit('data', Buffer.from('😀"\u0001é€'))
        child.stderr.emit('data', Buffer.from('after-overflow'))
      }
    })
    const capped = await setup({ maxOutputBytes: 4 })
    const cappedResult = await capped.runtime.run(request())
    expect(cappedResult.error?.kind).toBe('output-limit')
    expect(cappedResult.logs).toEqual([])
    const cappedBytes = Buffer.byteLength(JSON.stringify(cappedResult.logs))
      + Buffer.byteLength(JSON.stringify(cappedResult.error?.message))
    expect(cappedBytes).toBeLessThanOrEqual(4)
    await capped.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'log', text: '' })
        child.protocol.send({ type: 'log', text: 'x' })
      }
    })
    const emptyBoundary = await setup({ maxOutputBytes: 4 })
    await expect(emptyBoundary.runtime.run(request())).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await emptyBoundary.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'log', text: 'kept' })
        child.protocol.send({ type: 'log', text: 'z'.repeat(200) })
      }
    })
    const partial = await setup({ maxOutputBytes: 64 })
    const partialResult = await partial.runtime.run(request())
    expect(partialResult.error?.kind).toBe('output-limit')
    expect(partialResult.logs[0]).toBe('kept')
    expect(partialResult.logs[1]?.length).toBeGreaterThan(0)
    await partial.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'log', text: 'a'.repeat(24) })
        child.protocol.send({ type: 'log', text: '😀' })
        child.protocol.send({ type: 'log', text: 'z'.repeat(100) })
      }
    })
    const emptyPrefix = await setup({ maxOutputBytes: 64 })
    await expect(emptyPrefix.runtime.run(request())).resolves.toMatchObject({ error: { kind: 'output-limit' }, logs: ['a'.repeat(24)] })
    await emptyPrefix.fiber.dispose()
  })

  it('rebuilds split frames and drops malformed, invalid UTF-8, and oversized input', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        const done = JSON.stringify({ type: 'done', value: 'split' }) + '\n'
        child.protocol.emit('data', Buffer.from('not-json\n'))
        child.protocol.emit('data', Buffer.from([0xff, 0x0a]))
        child.protocol.emit('data', Buffer.from(done.slice(0, 7)))
        child.protocol.emit('data', Buffer.from(done.slice(7)))
      }
    })
    const split = await setup({ maxControlBytes: 1_152, maxOutputBytes: 128 })
    await expect(split.runtime.run(request())).resolves.toEqual({ logs: [], value: 'split' })
    await split.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.sendRaw('x'.repeat(1_153))
        child.protocol.sendRaw('ignored\n')
      }
    })
    const oversized = await setup({ maxControlBytes: 1_152, maxOutputBytes: 128 })
    await expect(oversized.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process violated the control protocol' },
    })
    await oversized.fiber.dispose()
  })

  it('answers unknown, duplicate, invalid-JSON, and rejecting binding calls', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.sendRaw('{"type":"call","id":1,"global":"missing","name":"x","args":null}\n')
        child.protocol.sendRaw('{"type":"call","id":1,"global":"missing","name":"x","args":null}\n')
      } else if (frame?.includes('"id":1')) {
        child.protocol.send({ type: 'done', value: 'unknown' })
      }
    })
    const unknown = await setup()
    await expect(unknown.runtime.run(request({ bindings: [namespace({ known: () => 1 })] }))).resolves.toEqual({ logs: [], value: 'unknown' })
    await unknown.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'call', id: 2, global: 'tools', name: 'reject', args: null })
      else if (frame?.includes('"id":2')) child.protocol.send({ type: 'done', value: 'rejected' })
    })
    const rejected = await setup()
    await expect(rejected.runtime.run(request({ bindings: [namespace({ reject: () => { throw new Error('no') } })] }))).resolves.toEqual({ logs: [], value: 'rejected' })
    await rejected.fiber.dispose()
  })

  it('uses the fallback reply when a binding result exceeds the control budget', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'call', id: 3, global: 'tools', name: 'large', args: null })
      else if (frame?.includes('"id":3')) child.protocol.send({ type: 'done', value: 'fallback' })
    })
    const runtime = await setup({ maxOutputBytes: 128, maxControlBytes: 1_152 })
    await expect(runtime.runtime.run(request({ bindings: [namespace({ large: () => 'x'.repeat(2_000) })] }))).resolves.toEqual({ logs: [], value: 'fallback' })
    await runtime.fiber.dispose()
  })

  it('contains late binding replies and snapshot failures after the run settles', async () => {
    let release!: (value: unknown) => void
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'call', id: 4, global: 'tools', name: 'pending', args: null })
        child.protocol.send({ type: 'done', value: 'finished' })
      }
    })
    const pending = await setup()
    const pendingResult = pending.runtime.run(request({
      bindings: [namespace({ pending: () => new Promise((resolve) => { release = resolve }) })],
    }))
    await expect(pendingResult).resolves.toEqual({ logs: [], value: 'finished' })
    release(1)
    await Promise.resolve()
    await pending.fiber.dispose()

    const snapshotFailure = await setup()
    const throwingValue = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('getter failed') } })
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'call', id: 6, global: 'tools', name: 'throwsWhileSnapshotting', args: null })
      else if (frame?.includes('"id":6')) child.protocol.send({ type: 'done', value: 'snapshot-caught' })
    })
    await expect(snapshotFailure.runtime.run(request({ bindings: [namespace({ throwsWhileSnapshotting: () => throwingValue })] }))).resolves.toEqual({ logs: [], value: 'snapshot-caught' })
    await snapshotFailure.fiber.dispose()
  })

  it('ignores frames in the wrong lifecycle state and unsafe or unknown wire frames', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) {
        child.protocol.send({ type: 'done', value: 'before-boot' })
        child.protocol.send({ type: 'boot-ack' })
      } else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'boot-ack' })
        child.protocol.sendRaw(`{"type":"done","value":${'9'.repeat(400)}}\n`)
        child.protocol.sendRaw('{"type":"unknown"}\n')
        child.protocol.send({ type: 'done', value: 'done' })
        child.protocol.send({ type: 'log', text: 'after-done' })
      }
    })
    const runtime = await setup()
    await expect(runtime.runtime.run(request())).resolves.toEqual({ logs: [], value: 'done' })
    await runtime.fiber.dispose()
  })

  it('tolerates a protocol end race while finishing normally', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) {
        child.input.throwOnEnd = true
        child.protocol.send({ type: 'boot-ack' })
      } else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'done', value: 1 })
    })
    const runtime = await setup()
    await expect(runtime.runtime.run(request())).resolves.toEqual({ logs: [], value: 1 })
    await runtime.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'done', value: 1 })
        child.stdout.emit('data', Buffer.from('x'.repeat(1_000)))
      }
    })
    const lateOutput = await setup({ maxOutputBytes: 128 })
    await expect(lateOutput.runtime.run(request())).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await lateOutput.fiber.dispose()
  })

  it('returns host-side protocol errors and all child done variants', async () => {
    const runtime = await setup({ maxOutputBytes: 128 })
    const runFrame = async (done: ChildFrame): Promise<unknown> => {
      spawnMock.mockImplementationOnce(() => new FakeChild((child) => {
        const frame = child.protocol.writes.at(-1)
        if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
        else if (frame?.startsWith('{"type":"run"')) {
          if (Object.is(done.value, -0)) child.protocol.sendRaw('{"type":"done","value":-0}\n')
          else child.protocol.send(done)
        }
      }) as never)
      return runtime.runtime.run(request())
    }

    await expect(runFrame({ type: 'done' })).resolves.toEqual({ logs: [] })
    await expect(runFrame({ type: 'done', value: null })).resolves.toEqual({ logs: [], value: null })
    await expect(runFrame({ type: 'done', value: 9_007_199_254_740_992 })).resolves.toEqual({ logs: [], value: 9_007_199_254_740_992 })
    await expect(runFrame({ type: 'done', error: { kind: 'exception', message: 'failed at /private/key' } })).resolves.toEqual({
      logs: [], error: { kind: 'exception', message: 'failed at <path>' },
    })
    await expect(runFrame({ type: 'done', error: { kind: 'invalid-output', message: 'invalid' }, value: 1 })).resolves.toEqual({
      logs: [], error: { kind: 'invalid-output', message: 'invalid' },
    })
    await expect(runFrame({ type: 'done', value: -0 })).resolves.toEqual({
      logs: [], error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
    })
    await expect(runFrame({ type: 'done', value: { ['k'.repeat(200)]: 1 } })).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await expect(runFrame({ type: 'done', value: Array.from({ length: 128 }, () => 1) })).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await expect(runFrame({ type: 'done', value: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index])) })).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await expect(runFrame({ type: 'done', value: 'x'.repeat(200) })).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await expect(runFrame({ type: 'done', error: { kind: 'exception', message: 'x'.repeat(200) } })).resolves.toMatchObject({ error: { kind: 'output-limit' } })

    spawnMock.mockImplementationOnce(() => new FakeChild((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.send({ type: 'log', text: 'kept' })
        child.protocol.send({ type: 'done', error: { kind: 'exception', message: 'x'.repeat(200) } })
      }
    }) as never)
    await expect(runtime.runtime.run(request())).resolves.toMatchObject({ error: { kind: 'output-limit' }, logs: ['kept'] })

    spawnMock.mockImplementationOnce(() => new FakeChild((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.protocol.send({ type: 'done', value: 123 })
    }) as never)
    const tiny = await setup({ maxOutputBytes: 4 })
    await expect(tiny.runtime.run(request())).resolves.toMatchObject({ error: { kind: 'output-limit' } })
    await tiny.fiber.dispose()

    Object.defineProperty(Object.prototype, '__pythonRuntimeCoverageInherited', { configurable: true, enumerable: true, value: 1, writable: true })
    try {
      await expect(runFrame({ type: 'done', value: { own: 1 } })).resolves.toEqual({ logs: [], value: { own: 1 } })
    } finally {
      delete (Object.prototype as Record<string, unknown>).__pythonRuntimeCoverageInherited
    }
    await runtime.fiber.dispose()
  })

  it('handles process exit, CPU signal, control errors, wall timeout, and abort', async () => {
    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.close(1)
    })
    const exited = await setup()
    await expect(exited.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process exited before completing' },
    })
    await exited.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.close(0)
    })
    const cleanExit = await setup()
    await expect(cleanExit.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process exited before completing' },
    })
    await cleanExit.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) child.close(null, 'SIGXCPU')
    })
    const cpu = await setup({ cpuSeconds: 7 })
    await expect(cpu.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'timeout', message: 'CPU budget exhausted (7s)' },
    })
    await cpu.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.protocol.emit('error', new Error('closed'))
        child.protocol.emit('error', new Error('already settling'))
      }
    })
    const controlError = await setup()
    await expect(controlError.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process control channel unavailable' },
    })
    await controlError.fiber.dispose()

    arm((child) => {
      const frame = child.protocol.writes.at(-1)
      if (frame?.startsWith('{"type":"boot"')) child.protocol.send({ type: 'boot-ack' })
      else if (frame?.startsWith('{"type":"run"')) {
        child.input.emit('error', new Error('closed'))
        child.input.emit('error', new Error('already settling'))
      }
    })
    const inputError = await setup()
    await expect(inputError.runtime.run(request())).resolves.toEqual({
      logs: [], error: { kind: 'worker-exit', message: 'python process control channel unavailable' },
    })
    await inputError.fiber.dispose()

    vi.useFakeTimers()
    arm(() => {})
    const wall = await setup({ maxWallMs: 20 })
    const wallRun = wall.runtime.run(request())
    await vi.advanceTimersByTimeAsync(20)
    await expect(wallRun).resolves.toEqual({ logs: [], error: { kind: 'timeout', message: 'wall-clock ceiling reached (20ms)' } })
    await wall.fiber.dispose()
    vi.useRealTimers()

    const controller = new AbortController()
    arm(() => {})
    const aborted = await setup()
    const abortedRun = aborted.runtime.run(request({ signal: controller.signal }))
    controller.abort()
    await expect(abortedRun).resolves.toEqual({ logs: [], error: { kind: 'abort', message: 'run aborted' } })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    await aborted.fiber.dispose()
  })

  it('disposes in-flight work and rejects later runs', async () => {
    arm(() => {})
    const { fiber, runtime, ctx } = await setup()
    const inFlight = runtime.run(request())
    await fiber.dispose()
    await expect(inFlight).resolves.toEqual({ logs: [], error: { kind: 'abort', message: 'runtime disposed' } })
    expect(ctx.get('codeRuntime')).toBeUndefined()
    await expect(runtime.run(request())).rejects.toThrow(/after disposal/)
  })
})
