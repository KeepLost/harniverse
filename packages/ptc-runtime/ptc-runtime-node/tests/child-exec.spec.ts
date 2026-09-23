import { describe, expect, it } from 'vitest'
import { ComputeMeter, LogBuffer, bindingTarget, makeBindingErrorClasses, makeConsoleShim, makeNamespaces, captureStreamWrites, prepareCompletion, prepareException, restoreBoundaryIntrinsics, runChildMain } from '../src/child-exec.ts'
import type { ExecutorChannel, PatchableStream } from '../src/child-exec.ts'
import { boundaryIntactForTest } from '../src/child-exec.ts'
import type { ControlDonePayload } from '@deepseek-ai/dsh-control-channel'
import { decodeWorkerJson, encodeWorkerJson } from '../src/json-wire.ts'

/**
 * An in-process stand-in for the child's control channel: the test plays the
 * HOST side — inspect what the executor sent, answer binding calls — so
 * every line of child-side logic runs under coverage without spawning a
 * process (real-child behavior is pinned by ptc-runtime.spec.ts).
 */
class FakeChannel implements ExecutorChannel {
  sentLogs: string[] = []
  limits: ('output' | 'pending-calls')[] = []
  dones: ControlDonePayload[] = []
  calls: { target: string; args: readonly unknown[] }[] = []
  /** Host-scripted responder; return a value to resolve, throw to deny, leave pending otherwise. */
  respond: (target: string, wireArgs: readonly unknown[]) => unknown = () => undefined

  call(target: string, args: readonly unknown[]): Promise<unknown> {
    this.calls.push({ target, args })
    return new Promise((resolve, reject) => {
      try {
        const result = this.respond(target, args)
        if (result !== undefined) resolve(result)
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  sendLog(text: string): void {
    this.sentLogs.push(text)
  }

  sendLimit(limit: 'output' | 'pending-calls'): void {
    this.limits.push(limit)
  }

  sendDone(outcome: ControlDonePayload): void {
    this.dones.push(outcome)
  }

  doneValue(): unknown {
    const done = this.dones[0]
    return done !== undefined && !('error' in done) && done.value !== undefined ? decodeWorkerJson(done.value) : undefined
  }

  doneError(): { kind: string; message: string } | undefined {
    const done = this.dones[0]
    return done !== undefined && 'error' in done ? done.error : undefined
  }
}

function fakeStreams(): { stdout: PatchableStream; stderr: PatchableStream } {
  return { stdout: { write: () => true }, stderr: { write: () => true } }
}

/** Capture one promise rejection without Vitest's intentionally `any` matcher channel. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error: unknown) {
    return error
  }
}

/** A meter that never reports: the sample stays at its baseline forever. */
const SILENT_METER = new ComputeMeter(Number.POSITIVE_INFINITY, () => ({ active: 0 }))

const BOOT = { maxOutputBytes: 65_536, computeMs: 60_000, maxLogFrameBytes: 1_000_000 }
const TOOL_ERROR_CLASS = { name: 'ToolCallError', memberNameProperty: 'toolName' } as const

/** One child declaration for the PTC tools namespace. */
function toolNamespace(names: string[]) {
  return { global: 'tools', names, errorClass: TOOL_ERROR_CLASS }
}

describe('LogBuffer', () => {
  it('streams entries to the sink until the byte budget, then emits one fitting prefix and reports the limit once', () => {
    const seen: string[] = []
    let limits = 0
    const buffer = new LogBuffer(15, text => seen.push(text), 1_000, () => { limits += 1 })
    buffer.push('12345')
    buffer.push('123456')
    buffer.push('dropped')
    expect(seen).toEqual(['12345', '123'])
    expect(limits).toBe(1)
    expect(buffer.remainingOutputBytes()).toBe(0)

    const exactlyFull: string[] = []
    const fullBuffer = new LogBuffer(6, text => exactlyFull.push(text), 1_000)
    fullBuffer.push('12')
    fullBuffer.push('no-prefix-fits')
    expect(exactlyFull).toEqual(['12'])
  })

  it('byte-truncates one entry above the per-frame cap before admitting it', () => {
    const seen: string[] = []
    const buffer = new LogBuffer(1_000, text => seen.push(text), 5)
    buffer.push('abcdefghij')
    expect(seen).toEqual(['abc'])
    expect(buffer.remainingOutputBytes()).toBe(1_000 - 7)
  })
})

describe('makeConsoleShim', () => {
  it('captures the five methods and renders non-strings inspect-style', () => {
    const seen: string[] = []
    const shim = makeConsoleShim(new LogBuffer(1_000, text => seen.push(text), 1_000))
    shim.log('plain', { a: 1 })
    shim.info('i')
    shim.warn('w')
    shim.error('e')
    shim.debug('d')
    expect(seen).toEqual(['plain { a: 1 }', 'i', 'w', 'e', 'd'])
  })
})

describe('makeNamespaces non-Error denials', () => {
  it('renders a raw rejection value through the declared error class', async () => {
    const dones: ControlDonePayload[] = []
    // A deliberately raw (non-Error) rejection value: the wrap must render it.
    const rawReason: unknown = 'raw-denied'
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the raw value IS the case under test
    const rawRejection = Promise.reject(rawReason)
    const channel: ExecutorChannel = {
      call: () => rawRejection,
      sendLog: () => {},
      sendLimit: () => {},
      sendDone: (outcome) => { dones.push(outcome) },
    }
    const namespace = makeNamespaces({ namespaces: [toolNamespace(['x'])] }, channel)[0] as Record<string, (args: unknown) => Promise<unknown>>
    const invoke = namespace.x as (args: unknown) => Promise<unknown>
    const rejection = await invoke({}).then(() => undefined, (error: unknown) => error as Error)
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as { name?: string }).name).toBe('ToolCallError')
    expect((rejection as { message?: string }).message).toBe('raw-denied')
  })
})

describe('makeNamespaces late lookups', () => {
  it('returns undefined for Object.prototype collision names and symbol keys', async () => {
    const [namespace] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['declared'] }] }, new FakeChannel())
    expect(typeof (namespace as Record<string, unknown>).hasOwnProperty).toBe('undefined')
    expect(typeof (namespace as Record<string, unknown>).constructor).toBe('undefined')
    expect((namespace as Record<symbol, unknown>)[Symbol('late')]).toBeUndefined()
    // A declared collision-shaped name still bridges as an ordinary function;
    // an arbitrary undeclared name bridges to the host's unknown-binding denial.
    expect(typeof (namespace as Record<string, unknown>).declared).toBe('function')
    expect(typeof (namespace as Record<string, unknown>).missing).toBe('function')
  })
})

describe('captureStreamWrites', () => {
  it('redirects writes into the buffer and restores on request', () => {
    const seen: string[] = []
    const buffer = new LogBuffer(1_000, text => seen.push(text), 1_000)
    let underlying = ''
    const stream: PatchableStream = { write: (chunk: unknown) => { underlying += String(chunk); return true } }
    const restore = captureStreamWrites(buffer, stream)
    stream.write('captured', 'utf8')
    stream.write(Buffer.from('bytes'))
    restore()
    stream.write('after')
    expect(seen).toEqual(['captured', 'bytes'])
    expect(underlying).toBe('after')
  })

  it('invokes the write callback asynchronously, in both optional-encoding shapes', async () => {
    const buffer = new LogBuffer(1_000, () => {}, 1_000)
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    const calls: (Error | null | undefined)[] = []
    stream.write('two-arg', (error?: Error | null) => calls.push(error))
    stream.write('three-arg', 'utf8', (error?: Error | null) => calls.push(error))
    // Node's contract: the callback fires after the write call returns.
    expect(calls).toEqual([])
    await new Promise<void>(resolve => stream.write('awaited flush', resolve))
    expect(calls).toEqual([null, null])
  })

  it('still fires the callback for a write the exhausted budget drops', async () => {
    const buffer = new LogBuffer(4, () => {}, 1_000)
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    stream.write('this write overflows the budget and is dropped')
    await new Promise<void>(resolve => stream.write('also dropped', resolve))
  })
})

describe('prepareCompletion', () => {
  it('omits undefined and passes lossless JSON values exactly', () => {
    expect(prepareCompletion(undefined, 100)).toEqual({})
    expect(prepareCompletion({ a: [1, 'two'] }, 100)).toEqual({ value: encodeWorkerJson({ a: [1, 'two'] }) })
  })

  it('turns every lossy completion shape into invalid-output', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = Array(2)
    class Exotic { readonly marker = true }
    for (const value of [{ fn: () => 1 }, -0, Number.POSITIVE_INFINITY, sparse, cyclic, new Exotic()]) {
      expect(prepareCompletion(value, 1_000)).toEqual({
        error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
      })
    }
  })

  it('reports an oversized value instead of substituting rendered text', () => {
    expect(prepareCompletion('x'.repeat(50), 10)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 10 bytes' },
    })
  })

  it('measures the exact JSON serialization at and over the boundary', () => {
    expect(prepareCompletion('€', 5)).toEqual({ value: encodeWorkerJson('€') })
    expect(prepareCompletion('€', 4)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 4 bytes' },
    })
  })

  it('contains a getter failure as invalid-output', () => {
    const value = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('getter exploded') } })
    expect(prepareCompletion(value, 1_000)).toEqual({
      error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
    })
  })

  it('uses the remaining combined budget for invalid-output diagnostics', () => {
    expect(prepareCompletion(() => 1, 4, 64)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
    })
  })
})

describe('prepareException', () => {
  it('passes a fitting diagnostic and rejects one byte over without carrying its text', () => {
    expect(prepareException('boom', 6, 64)).toEqual({ error: { kind: 'exception', message: 'boom' } })
    expect(prepareException('boom', 5, 64)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
    })
  })

  it('contains a thrown value whose string conversion fails', () => {
    const thrown = { toString() { throw new Error('cannot render') } }
    expect(prepareException(thrown, 1_000)).toEqual({
      error: { kind: 'exception', message: 'program threw an unrenderable value' },
    })

    const strangeStack = Object.defineProperty(new Error('ignored'), 'stack', { value: 42 })
    expect(prepareException(strangeStack, 1_000)).toEqual({
      error: { kind: 'exception', message: '42' },
    })
  })
})

describe('ComputeMeter', () => {
  it('reports once when the sampled active total crosses the budget', async () => {
    let active = 0
    const reported: { kind: string; message: string }[] = []
    const meter = new ComputeMeter(100, () => ({ active }))
    meter.start((failure) => { reported.push(failure) })
    active = 50
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reported).toEqual([])
    active = 200
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reported).toEqual([{ kind: 'timeout', message: 'compute budget exhausted (100ms busy)' }])
    // The report fires exactly once even when sampling continues.
    active = 400
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reported).toHaveLength(1)
    meter.stop()
  })

  it('stop disarms the sampler and allows re-arming', async () => {
    let active = 0
    const reported: unknown[] = []
    const meter = new ComputeMeter(10, () => ({ active }))
    meter.start((failure) => { reported.push(failure) })
    meter.stop()
    active = 1_000
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reported).toEqual([])
  })
})

describe('bindingTarget', () => {
  it('builds and splits targets with identifier globals and arbitrary names', () => {
    expect(bindingTarget('tools', 'read')).toBe('binding:tools:read')
    expect(bindingTarget('helpers', 'weird:name:with:colons')).toBe('binding:helpers:weird:name:with:colons')
    const target = bindingTarget('helpers', 'weird:name')
    const separator = target.indexOf(':', 'binding:'.length)
    expect(target.slice('binding:'.length, separator)).toBe('helpers')
    expect(target.slice(separator + 1)).toBe('weird:name')
  })
})

describe('makeNamespaces', () => {
  it('exposes prototype-colliding names as ordinary own properties', async () => {
    const channel = new FakeChannel()
    channel.respond = (target) => {
      const separator = target.indexOf(':', 'binding:'.length)
      const name = target.slice(separator + 1)
      return encodeWorkerJson(`${name}-ok`)
    }
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['__proto__', 'constructor', 'toString'] }] }, channel) as [Record<string, (args: unknown) => Promise<unknown>>]
    expect(Object.getPrototypeOf(tools)).toBeNull()
    await expect(tools['__proto__']?.({})).resolves.toBe('__proto__-ok')
    await expect(tools['constructor']?.({})).resolves.toBe('constructor-ok')
    await expect(tools['toString']?.({})).resolves.toBe('toString-ok')
    expect(channel.calls.map(call => call.target)).toEqual([
      'binding:tools:__proto__', 'binding:tools:constructor', 'binding:tools:toString',
    ])
  })

  it('rejects lossy arguments before posting any call', async () => {
    const channel = new FakeChannel()
    const [tools] = makeNamespaces({ namespaces: [toolNamespace(['x'])] }, channel) as [Record<string, (args: unknown) => Promise<unknown>>]
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const throwing = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { throw new Error('getter exploded') },
    })

    for (const value of [() => 1, new Date(), decorated, throwing]) {
      const failure = await rejectionOf(tools.x?.(value) ?? Promise.resolve())
      expect(failure).toMatchObject({
        name: 'ToolCallError', toolName: 'x', message: 'binding arguments must be lossless JSON',
      })
    }
    expect(channel.calls).toHaveLength(0)
  })

  it('rejects a channel denial as the declared error class and a lossy success as lossless-JSON', async () => {
    const denied = new FakeChannel()
    denied.respond = () => { throw new Error('helper denied') }
    const [helpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, denied) as [Record<string, (args: unknown) => Promise<unknown>>]
    const denial = await rejectionOf(helpers.x?.({}) ?? Promise.resolve())
    expect(denial).toBeInstanceOf(Error)
    expect(denial).toMatchObject({ name: 'Error', message: 'helper denied' })
    expect(denial).not.toHaveProperty('toolName')

    const lossy = new FakeChannel()
    lossy.respond = () => [undefined] // a wire shape decodeWorkerJson rejects
    const [lossyHelpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, lossy) as [Record<string, (args: unknown) => Promise<unknown>>]
    const lossyFailure = await rejectionOf(lossyHelpers.x?.({}) ?? Promise.resolve())
    expect(lossyFailure).toMatchObject({ message: 'binding resolution must be lossless JSON' })
  })

  it('shares one error-class identity between calls and instanceof', async () => {
    const denied = new FakeChannel()
    denied.respond = () => { throw new Error('no') }
    const data = { namespaces: [toolNamespace(['x'])] }
    const errorClasses = makeBindingErrorClasses(data)
    const ToolCallError = errorClasses.get('tools')
    const [tools] = makeNamespaces(data, denied, errorClasses) as [Record<string, (args: unknown) => Promise<unknown>>]
    const first = await rejectionOf(tools.x?.({}) ?? Promise.resolve())
    expect(first).toBeInstanceOf(ToolCallError)
    expect(first).toMatchObject({ name: 'ToolCallError', toolName: 'x' })
  })
})

describe('runChildMain', () => {
  it('runs a program end-to-end: bindings, console, return value', async () => {
    const channel = new FakeChannel()
    channel.respond = (_target, wireArgs) => {
      const args = decodeWorkerJson(wireArgs[0]) as { n: number }
      return encodeWorkerJson(args.n * 2)
    }
    await runChildMain(channel, {
      ...BOOT,
      code: 'const doubled = await tools.double({ n: 21 }); console.log("got", doubled); return { doubled };',
      namespaces: [{ global: 'tools', names: ['double'] }],
    }, fakeStreams(), SILENT_METER)
    expect(channel.sentLogs).toEqual(['got 42'])
    expect(channel.doneValue()).toEqual({ doubled: 42 })
  })

  it('reports child-side log capture overflow before completing', async () => {
    const channel = new FakeChannel()
    await runChildMain(channel, {
      ...BOOT,
      maxOutputBytes: 4,
      code: 'console.log("12345"); return null',
      namespaces: [],
    }, fakeStreams(), SILENT_METER)
    expect(channel.sentLogs).toEqual([])
    expect(channel.limits).toEqual(['output'])
    expect(channel.doneError()).toEqual({ kind: 'output-limit', message: 'outer output exceeded 4 bytes' })
  })

  it('reports a thrown program error on the done payload', async () => {
    const channel = new FakeChannel()
    await runChildMain(channel, { ...BOOT, code: 'throw new Error("boom")', namespaces: [] }, fakeStreams(), SILENT_METER)
    expect(channel.doneError()?.kind).toBe('exception')
    expect(channel.doneError()?.message).toContain('boom')
    expect(channel.doneValue()).toBeUndefined()
  })

  it('renders non-Error throws and stack-less Errors on the done payload', async () => {
    const raw = new FakeChannel()
    await runChildMain(raw, { ...BOOT, code: 'throw "raw-throw"', namespaces: [] }, fakeStreams(), SILENT_METER)
    expect(raw.doneError()).toEqual({ kind: 'exception', message: 'raw-throw' })

    const bare = new FakeChannel()
    await runChildMain(bare, { ...BOOT, code: 'const e = new Error("bare"); e.stack = undefined; throw e', namespaces: [] }, fakeStreams(), SILENT_METER)
    expect(bare.doneError()).toEqual({ kind: 'exception', message: 'bare' })
  })

  it('replaces giant thrown strings and Error stacks before sending the done payload', async () => {
    const raw = new FakeChannel()
    await runChildMain(raw, {
      ...BOOT,
      maxOutputBytes: 64,
      code: 'throw "x".repeat(1_000_000)',
      namespaces: [],
    }, fakeStreams(), SILENT_METER)
    expect(raw.doneError()).toEqual({ kind: 'output-limit', message: 'outer output exceeded 64 bytes' })

    const stacked = new FakeChannel()
    await runChildMain(stacked, {
      ...BOOT,
      maxOutputBytes: 64,
      code: 'throw new Error("x".repeat(1_000_000))',
      namespaces: [],
    }, fakeStreams(), SILENT_METER)
    expect(stacked.doneError()).toEqual({ kind: 'output-limit', message: 'outer output exceeded 64 bytes' })
  })

  it('surfaces a host denial as a program-side rejection it can catch', async () => {
    const channel = new FakeChannel()
    channel.respond = () => { throw new Error('denied by host') }
    await runChildMain(channel, {
      ...BOOT,
      code: 'try { await tools.x({}) } catch (error) { return { caught: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } }',
      namespaces: [toolNamespace(['x'])],
    }, fakeStreams(), SILENT_METER)
    expect(channel.doneValue()).toEqual({ caught: true, name: 'ToolCallError', toolName: 'x', message: 'denied by host' })
  })

  it('materializes a consumer-declared rejection class without knowing the namespace', async () => {
    const channel = new FakeChannel()
    channel.respond = () => { throw new Error('helper denied') }
    await runChildMain(channel, {
      ...BOOT,
      code: 'try { await helpers.x({}) } catch (error) { return { caught: error instanceof HelperCallError, name: error.name, helperName: error.helperName, message: error.message } }',
      namespaces: [{
        global: 'helpers',
        names: ['x'],
        errorClass: { name: 'HelperCallError', memberNameProperty: 'helperName' },
      }],
    }, fakeStreams(), SILENT_METER)
    expect(channel.doneValue()).toEqual({ caught: true, name: 'HelperCallError', helperName: 'x', message: 'helper denied' })
  })

  it('sends the compute-meter failure instead of the program completion once it fires', async () => {
    // First sample (the baseline) reads 0; every later sample reads over the
    // 10ms budget, so the first interval tick reports while the program sleeps.
    let samples = 0
    const meter = new ComputeMeter(10, () => ({ active: samples++ === 0 ? 0 : 100 }))
    const channel = new FakeChannel()
    await runChildMain(channel, {
      ...BOOT,
      code: 'await new Promise(resolve => setTimeout(resolve, 120)); return 1',
      namespaces: [],
    }, fakeStreams(), meter)
    expect(channel.dones).toEqual([{ error: { kind: 'timeout', message: 'compute budget exhausted (10ms busy)' } }])
  })

  it('arms the real ELU meter by default for one in-process run', async () => {
    const channel = new FakeChannel()
    const streams = fakeStreams()
    await runChildMain(channel, { ...BOOT, code: 'return 1', namespaces: [] }, streams)
    expect(channel.doneValue()).toBe(1)
  })

  it('captures raw stream writes through the patched process streams', async () => {
    const channel = new FakeChannel()
    const streams = fakeStreams()
    await runChildMain(channel, { ...BOOT, code: 'return 1', namespaces: [] }, streams, SILENT_METER)
    streams.stdout.write('post-run write lands in the still-patched buffer')
    expect(channel.sentLogs.at(-1)).toBe('post-run write lands in the still-patched buffer')
  })
})

describe('boundary-intrinsic triage', () => {
  // These tests mutate THIS process's real prototype surfaces; every case
  // restores the boundary before asserting so the suite stays side-effect
  // free. Globals like `Error` itself are never deleted — the test runner
  // needs them — so the triage targets prototype/static arms instead.
  const arm = (target: object, key: string, value: unknown): void => {
    // Null-prototype descriptor: once Object.prototype.get is armed below,
    // a bare descriptor literal would inherit that accessor and be rejected.
    const descriptor = Object.create(null) as { value: unknown; writable: true; configurable: true; enumerable: false }
    descriptor.value = value
    descriptor.writable = true
    descriptor.configurable = true
    descriptor.enumerable = false
    Object.defineProperty(target, key, descriptor)
  }

  it('reports the pristine boundary as intact', () => {
    expect(boundaryIntactForTest()).toBe(true)
  })

  it('restores prototype methods, statics, and globals a program dirtied', () => {
    const pristineArrayPop = Array.prototype.pop
    // No assertions run while the boundary is armed: an armed
    // Object.prototype.get breaks the runner's own expect machinery.
    let intactWhileArmed = true
    try {
      arm(Array.prototype, 'pop', () => { throw new Error('armed') })
      arm(Object.prototype, 'get', () => undefined)
      arm(Object, 'keys', () => [])
      intactWhileArmed = boundaryIntactForTest()
    } finally {
      restoreBoundaryIntrinsics()
    }
    expect(intactWhileArmed).toBe(false)
    expect(boundaryIntactForTest()).toBe(true)
    expect(Array.prototype.pop).toBe(pristineArrayPop)
    expect((Object.prototype as { get?: unknown }).get).toBeUndefined()
    expect(Object.keys({ a: 1 })).toEqual(['a'])
  })

  it('restores through the ensure-triage when a LogBuffer entry crosses a dirty boundary', () => {
    try {
      arm(Array.prototype, 'pop', () => { throw new Error('armed') })
      const seen: string[] = []
      new LogBuffer(1_000, (text) => { seen.push(text) }, 100).push('while armed')
      expect(boundaryIntactForTest()).toBe(true)
      expect(seen).toEqual(['while armed'])
    } finally {
      restoreBoundaryIntrinsics()
    }
  })

  it('drops keys a program ADDED to snapshotted surfaces', () => {
    try {
      arm(Array.prototype, 'armedLater', () => 'armed')
      arm(Object, 'plantedStatic', 1)
      restoreBoundaryIntrinsics()
      expect((Array.prototype as { armedLater?: unknown }).armedLater).toBeUndefined()
      expect((Object as { plantedStatic?: unknown }).plantedStatic).toBeUndefined()
    } finally {
      restoreBoundaryIntrinsics()
    }
  })
})
