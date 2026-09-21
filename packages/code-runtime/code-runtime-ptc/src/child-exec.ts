/**
 * Child-side execution logic, written as plain functions over an injected
 * channel so the unit suite can run every line IN-PROCESS against a fake
 * channel (a real child process is a separate OS process the coverage
 * provider cannot observe).
 * @module @deepseek-ai/dsh-code-runtime-ptc/src/child-exec
 */

import { inspect } from 'node:util'
import { performance } from 'node:perf_hooks'
import type { ControlDonePayload, ControlFailure } from '@deepseek-ai/dsh-control-channel'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodeWorkerJson, encodeWorkerJson, snapshotCodeJsonValue } from './json-wire.ts'

const CapturedError = Error
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty

/** Define one public binding-error field without consulting mutable globals or descriptor prototypes. */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
}

/**
 * The channel API the child executor needs — satisfied by a
 * `ControlChannelTransport` over the process stdio pair and by the tests'
 * fake. `call` bridges one program-side binding invocation to the host.
 */
export interface ExecutorChannel {
  call(target: string, args: readonly unknown[]): Promise<unknown>
  sendLog(text: string): void
  sendLimit(limit: 'output' | 'pending-calls'): void
  sendDone(outcome: ControlDonePayload): void
}

/**
 * A writable stream's `write` slot, as the executor patches it (see
 * {@link captureStreamWrites}). Method-typed so the real
 * `process.stdout`/`process.stderr` (narrower chunk parameters) remain
 * assignable.
 */
export interface PatchableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean
}

// ---------------------------------------------------------------------------
// Boundary-intrinsic triage.
//
// Model code may mutate constructor globals and prototype methods Node's own
// event-loop machinery depends on (async_hooks pops the execution stack via
// `Array.prototype.pop` after every timer callback). The compute meter is the
// child's only timer, and its callback runs BEFORE that pop — so restoring
// the pristine boundary at the top of every tick keeps a mutated child alive.
// Restoration is observable to the program (mutations revert within one
// 25ms tick), the honest price of not dying; documented in the README.
// ---------------------------------------------------------------------------

const intrinsicArrayIsArray = Array.isArray
const capturedObjectHasOwn = Object.hasOwn
const capturedReflectGet = Reflect.get
const IntrinsicArray = Array
const IntrinsicObject = Object
const intrinsicArrayPrototype = Array.prototype
const intrinsicObjectPrototype = Object.prototype
const pristineArrayPop = Array.prototype.pop
const pristineObjectDefineProperty = Object.defineProperty
const capturedGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const capturedDefineProperty = Object.defineProperty
const capturedDeleteProperty = Reflect.deleteProperty
const capturedOwnKeys = Reflect.ownKeys
const intrinsicGlobalThis = globalThis

/** Constructors and namespaces whose statics and/or prototype get snapshotted. */
const BOUNDARY_OBJECTS: readonly object[] = [
  Array, Object, Function, String, Number, Boolean, Symbol, Set, Map, WeakSet, WeakMap,
  Promise, RegExp, Date, Error, TypeError, RangeError, ReferenceError, SyntaxError, EvalError,
  URIError, AggregateError, Reflect, JSON, Math,
]

interface BoundarySnapshot {
  readonly statics: ReadonlyMap<PropertyKey, PropertyDescriptor>
  readonly prototype: ReadonlyMap<PropertyKey, PropertyDescriptor> | undefined
}

/**
 * Copy one descriptor onto a null-prototype holder. A bare object descriptor
 * inherits accessors once model code plants `Object.prototype.get`, and
 * `defineProperty` then rejects value+accessor hybrids — restoration must
 * stay immune to that pollution.
 */
function plainDescriptor(source: PropertyDescriptor): PropertyDescriptor {
  const copy = capturedObjectCreate(null) as Record<PropertyKey, unknown>
  for (const key of ['value', 'writable', 'enumerable', 'configurable', 'get', 'set']) {
    const value = (source as Record<string, unknown>)[key]
    if (value !== undefined) copy[key] = value
  }
  return copy
}

const boundarySnapshots: ReadonlyMap<object, BoundarySnapshot> = new Map(BOUNDARY_OBJECTS.map((ctor) => {
  const statics = new Map<PropertyKey, PropertyDescriptor>(
    Object.entries(capturedGetOwnPropertyDescriptors(ctor)).map(([key, descriptor]) => [key, plainDescriptor(descriptor)]),
  )
  const proto = (ctor as { prototype?: object }).prototype
  const prototype = proto === undefined
    ? undefined
    : new Map<PropertyKey, PropertyDescriptor>(
      Object.entries(capturedGetOwnPropertyDescriptors(proto)).map(([key, descriptor]) => [key, plainDescriptor(descriptor)]),
    )
  return [ctor, { statics, prototype }]
}))

/** Global constructor bindings restored verbatim (name → pristine value). */
const boundaryGlobals: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Array', Array], ['Object', Object], ['Function', Function], ['String', String],
  ['Number', Number], ['Boolean', Boolean], ['Symbol', Symbol], ['Set', Set], ['Map', Map],
  ['WeakSet', WeakSet], ['WeakMap', WeakMap], ['Promise', Promise], ['RegExp', RegExp],
  ['Date', Date], ['Error', Error], ['TypeError', TypeError], ['RangeError', RangeError],
  ['ReferenceError', ReferenceError], ['SyntaxError', SyntaxError], ['EvalError', EvalError],
  ['URIError', URIError], ['AggregateError', AggregateError], ['Reflect', Reflect],
  ['JSON', JSON], ['Math', Math], ['Buffer', Buffer],
])

/** Cheap dirty check over the mutations hostile programs actually make. */
function boundaryIntact(): boolean {
  return IntrinsicArray.isArray === intrinsicArrayIsArray
    && intrinsicArrayPrototype.pop === pristineArrayPop
    && IntrinsicObject.defineProperty === pristineObjectDefineProperty
    && intrinsicObjectPrototype.constructor === IntrinsicObject
    && intrinsicGlobalThis.Error === IntrinsicError
    && intrinsicGlobalThis.Array === IntrinsicArray
    && intrinsicGlobalThis.Object === IntrinsicObject
    && intrinsicGlobalThis.String === IntrinsicString
    && intrinsicGlobalThis.Reflect === IntrinsicReflect
    && intrinsicGlobalThis.Set === IntrinsicSet
}

/** Restore every snapshotted surface (statics, prototypes, global bindings). */
export function restoreBoundaryIntrinsics(): void {
  for (const [ctor, snapshot] of boundarySnapshots) {
    for (const key of capturedOwnKeys(ctor)) {
      if (typeof key === 'string' && !snapshot.statics.has(key)) capturedDeleteProperty(ctor, key)
    }
    for (const [key, descriptor] of snapshot.statics) capturedDefineProperty(ctor, key, descriptor)
    const proto = (ctor as { prototype?: object }).prototype
    if (proto !== undefined && snapshot.prototype !== undefined) {
      for (const key of capturedOwnKeys(proto)) {
        if (typeof key === 'string' && !snapshot.prototype.has(key)) capturedDeleteProperty(proto, key)
      }
      for (const [key, descriptor] of snapshot.prototype) capturedDefineProperty(proto, key, descriptor)
    }
  }
  for (const [name, value] of boundaryGlobals) {
    capturedDefineProperty(intrinsicGlobalThis, name, { value, writable: true, enumerable: false, configurable: true })
  }
}

/** Test-only exposure of the intactness probe (the triage itself is internal). */
export function boundaryIntactForTest(): boolean {
  return boundaryIntact()
}

/** Triage used at suspension points: restore the boundary only when dirtied. */
export function ensureBoundaryIntrinsics(): void {
  if (!boundaryIntact()) restoreBoundaryIntrinsics()
}

// Module-captured intrinsics: model code may rebind or delete the global
// constructors mid-run, and post-program child paths must keep working.
const IntrinsicError = Error
const IntrinsicString = String
const IntrinsicReflect = Reflect
const IntrinsicSet = Set

/**
 * Ordered text capture under the shared outer JSON-byte budget, delivered to
 * a sink as each item lands (the real sink streams `log` frames eagerly, so
 * captured output survives a mid-run termination). It includes the log
 * array syntax and string escaping in its accounting. Once exhausted it emits
 * the fitting prefix and reports the limit once; the host turns that
 * condition into an explicit `output-limit` run failure.
 */
export class LogBuffer {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0
  private truncated = false
  // Explicit fields, not constructor parameter properties: this module loads
  // under Node's native strip-only mode, which rejects non-erasable syntax —
  // and parameter properties are non-erasable.
  private readonly sink: (text: string) => void
  private readonly onLimit: () => void
  private readonly maxBytes: number
  private readonly maxEntryBytes: number

  /**
   * @param maxBytes - the shared outer JSON-byte budget for logs, completion
   *   value, and failure diagnostics.
   * @param sink - the eager delivery target for admitted entries.
   * @param maxEntryBytes - per-entry cap keeping one `log` frame encodable
   *   within the channel's frame bound; a longer entry is byte-truncated.
   * @param onLimit - invoked once when the outer budget exhausts.
   */
  constructor(maxBytes: number, sink: (text: string) => void, maxEntryBytes: number, onLimit: () => void = () => {}) {
    this.maxBytes = maxBytes
    this.sink = sink
    this.maxEntryBytes = maxEntryBytes
    this.onLimit = onLimit
  }

  /**
   * Emit text to the sink, charging it against the budget (drops + marks once exhausted).
   * @param text - the captured text to deliver.
   */
  push(text: string): void {
    // Program-facing entry: triage boundary intrinsics before any encoded
    // machinery runs (the sink hands text to the transport).
    ensureBoundaryIntrinsics()
    if (this.truncated) return
    let entry = text
    const entryBytes = jsonStringBytesUpTo(entry, this.maxEntryBytes)
    if (entryBytes === undefined) {
      entry = truncateJsonStringBytes(entry, this.maxEntryBytes)
    }
    const separatorBytes = this.entries > 0 ? 1 : 0
    const availableBytes = this.maxBytes - this.bytes - separatorBytes
    const stringBytes = jsonStringBytesUpTo(entry, availableBytes)
    if (stringBytes === undefined) {
      this.truncated = true
      const prefix = truncateJsonStringBytes(entry, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees the returned prefix fits. */
        if (prefixBytes === undefined) throw new CapturedError('child output ledger produced an oversized log prefix')
        this.bytes += prefixBytes + separatorBytes
        this.entries += 1
        this.sink(prefix)
      }
      this.onLimit()
      return
    }
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    this.sink(entry)
  }

  /** Remaining exact JSON-byte budget for the completion value or failure message. */
  remainingOutputBytes(): number {
    return this.maxBytes - this.bytes
  }
}

/** The five console methods the shim captures, in the seam's level vocabulary. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * A `console` replacement whose five leveled methods render their arguments
 * `util.inspect`-style (matching real console formatting closely enough for
 * a model to recognize its own output) into the buffer. Only these five
 * exist — the program gets a deliberately small console, not Node's full
 * console API.
 * @param logs - the buffer every rendered line is pushed into.
 * @returns the five-method console object handed to the program.
 */
export function makeConsoleShim(logs: LogBuffer): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
  const render = (args: unknown[]): string =>
    args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS)).join(' ')
  const shim = Object.create(null) as Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void>
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args: unknown[]) => { logs.push(render(args)) }
  }
  return shim
}

/**
 * Redirect a stream's `write` into the log buffer (the program-visible
 * `process.stdout`/`process.stderr` in the real child), so raw writes land in emission order
 * alongside console output instead of racing down a pipe. It preserves Node's optional callback
 * contract: the callback runs asynchronously after admission, even when the log budget drops
 * the write.
 *
 * @param logs - the buffer captured writes are pushed into.
 * @param stream - the stream whose `write` slot is patched.
 * @returns the restore function (the in-process tests un-patch; the real
 *   child never needs to).
 */
export function captureStreamWrites(logs: LogBuffer, stream: PatchableStream): () => void {
  // The slot's VALUE is stored for restore and reassigned — never invoked
  // detached, so the unbound-method concern does not apply.
  // oxlint-disable-next-line typescript/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk))
    // Node's optional-encoding shape: the callback is whichever of the next
    // two positions holds a function (a non-function there is the encoding).
    const callback = [rest[0], rest[1]].find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    )
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  return () => { stream.write = original }
}

/** Bounded inspect options: deep enough to be useful, bounded so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/**
 * Prepare the program's completion value for the done frame. Only lossless
 * JSON crosses, and a value that does not fit the remaining combined outer
 * budget reports `output-limit`; the host revalidates hostile traffic and
 * remains authoritative for native pipe writes the child cannot observe.
 *
 * @param value - the program's completion value.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns the done-frame payload: `{}` for `undefined`, else a wire value or failure.
 */
export function prepareCompletion(
  value: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): ControlDonePayload {
  if (value === undefined) return {}
  let snapshot: ReturnType<typeof snapshotCodeJsonValue>
  try {
    snapshot = snapshotCodeJsonValue(value)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return prepareFailure(
      'invalid-output',
      'program completion must be lossless JSON',
      remainingOutputBytes,
      maxOutputBytes,
    )
  }
  if (jsonValueBytesUpTo(snapshot, remainingOutputBytes) === undefined) {
    return outputLimit(maxOutputBytes)
  }
  return { value: encodeWorkerJson(snapshot) }
}

/** Build the fixed overflow payload without carrying rejected variable bytes. */
function outputLimit(maxOutputBytes: number): ControlDonePayload {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** Admit one bounded failure message or replace it with the fixed overflow diagnostic. */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  remainingOutputBytes: number,
  maxOutputBytes: number,
): ControlDonePayload {
  if (jsonStringBytesUpTo(message, remainingOutputBytes) === undefined) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * Prepare a thrown program value without sending an unbounded stack or
 * string across the control channel.
 * @param error - the value thrown by the program.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns a bounded exception or fixed output-limit payload.
 */
export function prepareException(
  error: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): ControlDonePayload {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, remainingOutputBytes, maxOutputBytes)
}

/**
 * Build the `binding:<global>:<name>` target one program-side binding call
 * bridges over. Globals cannot contain `:` (the identifier rule), so the
 * FIRST separator splits the namespace from an arbitrary member name.
 * @param global - the namespace global the call targets.
 * @param name - the function name within the namespace.
 * @returns the control-call target.
 */
export function bindingTarget(global: string, name: string): string {
  return `binding:${global}:${name}`
}

/** Constructor type for one program-visible binding rejection class. */
export type BindingErrorConstructor = new (memberName: string, message: string) => Error

/**
 * How often the child samples its own event-loop utilization for the
 * `computeMs` budget. An internal cadence, not config: the only effect of
 * the interval is budget-expiry granularity (a run can overshoot by up to
 * one interval), and nothing a deployment could tune here improves that
 * without burning cycles the program needs.
 */
const ELU_POLL_INTERVAL_MS = 25

/**
 * The child-side busy-time meter: samples THIS process's measured
 * event-loop utilization and reports one `timeout` failure when the active
 * total crosses the budget. Metering measured busy time — not wall time —
 * keeps the budget fair (a program awaiting a slow binding accrues nothing).
 * A hot synchronous loop starves the sampling timer itself; the host-side
 * wall-clock deadline is the backstop for that case.
 */
export class ComputeMeter {
  private readonly computeMs: number
  private readonly sample: () => { readonly active: number }
  private timer: ReturnType<typeof setInterval> | undefined

  /**
   * @param computeMs - the busy-time budget in milliseconds.
   * @param sample - the utilization probe; injectable so the unit suite
   *   drives deterministic totals (the real child samples
   *   `perf_hooks.performance.eventLoopUtilization()`).
   */
  constructor(computeMs: number, sample: () => { readonly active: number }) {
    this.computeMs = computeMs
    this.sample = sample
  }

  /**
   * Arm the sampler around the program body.
   * @param report - invoked once when the budget expires, with the failure
   *   to report; never invoked again after {@link stop}.
   */
  start(report: (failure: ControlFailure) => void): void {
    this.stop()
    let reported = false
    const baseline = this.sample().active
    this.timer = setInterval(() => {
      // First, every tick: restore boundary intrinsics hostile code dirtied,
      // BEFORE Node's own timer bookkeeping (async_hooks' post-callback
      // `Array.prototype.pop`) runs on the mutated prototypes and dies.
      ensureBoundaryIntrinsics()
      const active = this.sample().active - baseline
      if (active > this.computeMs && !reported) {
        reported = true
        report({ kind: 'timeout', message: `compute budget exhausted (${this.computeMs}ms busy)` })
      }
    }, ELU_POLL_INTERVAL_MS)
  }

  /** Disarm the sampler (idempotent — one meter arms around one program). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

/**
 * Materialize the real error constructor declared by one namespace.
 * @param descriptor - program-global class name and member-name property.
 * @returns the constructor injected into the program and used for rejections.
 */
function makeBindingErrorClass(
  descriptor: { name: string; memberNameProperty: string },
): BindingErrorConstructor {
  return class BindingCallError extends CapturedError {
    constructor(memberName: string, message: string) {
      super(message)
      defineBindingErrorField(this, 'name', descriptor.name)
      defineBindingErrorField(this, descriptor.memberNameProperty, memberName)
    }
  }
}

/** Create the namespace-specific rejection for one failed binding call. */
function bindingFailure(errorClass: BindingErrorConstructor | undefined, memberName: string, message: string): Error {
  return errorClass ? new errorClass(memberName, message) : new CapturedError(message)
}

/** One declared namespace as it crosses the boot call: names, no functions. */
interface BootNamespace {
  global: string
  names: string[]
  errorClass?: { name: string; memberNameProperty: string }
}

/** Everything the child needs to run one program, as the boot call's args. */
export interface ChildBootData {
  /** The type-stripped (plain JS) program body. */
  code: string
  /** Binding namespaces to materialize; functions themselves stay host-side. */
  namespaces: BootNamespace[]
  /** Hard cap for the combined serialized outer logs plus completion value or failure diagnostic. */
  maxOutputBytes: number
  /**
   * Busy-time budget in milliseconds the child meters against its own
   * event-loop utilization; on expiry the run reports a `timeout` failure.
   */
  computeMs: number
  /** Per-entry byte cap for one `log` frame, keeping it encodable within the channel frame bound. */
  maxLogFrameBytes: number
}

/**
 * Build each declared error class once so calls and `instanceof` share constructor identity.
 * @param data - binding namespace declarations from the boot payload.
 * @returns constructors keyed by their owning namespace global.
 */
export function makeBindingErrorClasses(
  data: Pick<ChildBootData, 'namespaces'>,
): Map<string, BindingErrorConstructor> {
  const classes = new Map<string, BindingErrorConstructor>()
  for (const namespace of data.namespaces) {
    if (namespace.errorClass) classes.set(namespace.global, makeBindingErrorClass(namespace.errorClass))
  }
  return classes
}

/**
 * Build the binding namespace objects the program sees: one null-prototype global per
 * namespace, each declared name an own enumerable async function that bridges over the
 * channel (`__proto__`/`constructor`/`toString` are ordinary keys, never prototype collisions).
 * Lossy arguments reject before posting; host failure replies reject only the
 * corresponding call.
 *
 * @param data - the boot payload's namespace declarations (globals + names).
 * @param channel - the channel binding calls are bridged over.
 * @param errorClasses - per-namespace constructors shared with program globals.
 * @returns one namespace object per declaration, in declaration order.
 */
export function makeNamespaces(
  data: Pick<ChildBootData, 'namespaces'>,
  channel: ExecutorChannel,
  errorClasses: Map<string, BindingErrorConstructor> = makeBindingErrorClasses(data),
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const errorClass = errorClasses.get(global)
    // Null-prototype membership table: late lookups must not consult a
    // prototype model code may have armed with throwing methods.
    const declared = capturedObjectCreate(null) as Record<string, true>
    for (const name of names) declared[name] = true
    const call = (name: string, args: unknown): Promise<unknown> => {
      // Program-facing entry: triage boundary intrinsics before the channel's
      // own accounting runs inside this potentially-hostile realm.
      ensureBoundaryIntrinsics()
      let detached: ReturnType<typeof snapshotCodeJsonValue>
      try {
        detached = snapshotCodeJsonValue(args)
      } catch {
        detached = undefined
      }
      if (detached === undefined) {
        return Promise.reject(bindingFailure(errorClass, name, 'binding arguments must be lossless JSON'))
      }
      const wired = channel.call(bindingTarget(global, name), [encodeWorkerJson(detached)])
      return wired.then(
        (value) => {
          const decoded = decodeWorkerJson(value)
          if (decoded === undefined) {
            throw bindingFailure(errorClass, name, 'binding resolution must be lossless JSON')
          }
          return decoded
        },
        (error: unknown) => {
          throw bindingFailure(errorClass, name, error instanceof IntrinsicError ? error.message : String(error))
        },
      )
    }
    // Declared members bridge to the host. An arbitrary undeclared name
    // bridges too and comes back as the namespace's typed unknown-binding
    // failure instead of a bare "not a function" TypeError; names that live
    // on Object.prototype stay ordinary absent properties (undefined), so a
    // forged 'constructor' or 'hasOwnProperty' never reaches a callable.
    return new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (target, name) => {
        if (typeof name !== 'string') return capturedReflectGet(target, name) as unknown
        if (declared[name] !== true && capturedObjectHasOwn(intrinsicObjectPrototype, name)) return undefined
        return (args: unknown): Promise<unknown> => call(name, args)
      },
    })
  })
}

/**
 * Run one strict async-function body, allowing top-level `await` and `return`, and post exactly
 * one terminal done payload; a thrown program error becomes its `error` field.
 * @param channel - the control channel the run reports over.
 * @param data - the boot payload the host sent.
 * @param streams - stdout/stderr objects captured as program logs.
 * @param meter - the busy-time meter to arm around the program.
 * @returns after sending the done payload.
 */
export async function runChildMain(
  channel: ExecutorChannel,
  data: ChildBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
  /* v8 ignore next -- the real ELU meter arms only inside a spawned child, which per-file coverage never measures. */
  meter: ComputeMeter = new ComputeMeter(data.computeMs, () => performance.eventLoopUtilization()),
): Promise<void> {
  const logs = new LogBuffer(
    data.maxOutputBytes,
    (text) => { channel.sendLog(text) },
    data.maxLogFrameBytes,
    () => { channel.sendLimit('output') },
  )
  // The capture stays installed for the child's whole lifetime: writes after
  // the program settles (pending timers, late microtasks) still land in the
  // ledger rather than corrupting the channel's stdout.
  captureStreamWrites(logs, streams.stdout)
  captureStreamWrites(logs, streams.stderr)

  const errorClasses = makeBindingErrorClasses(data)
  const namespaces = makeNamespaces(data, channel, errorClasses)
  const errorClassParameters: string[] = []
  const errorClassValues: BindingErrorConstructor[] = []
  for (const namespace of data.namespaces) {
    if (!namespace.errorClass) continue
    errorClassParameters.push(namespace.errorClass.name)
    const errorClass = errorClasses.get(namespace.global)
    /* v8 ignore next -- makeBindingErrorClasses covers every declaration in the same data. */
    if (!errorClass) throw new CapturedError(`missing binding error class for ${namespace.global}`)
    errorClassValues.push(errorClass)
  }
  const consoleShim = makeConsoleShim(logs)

  const state = { earlyDone: false }
  meter.start((failure: ControlFailure) => {
    state.earlyDone = true
    channel.sendDone({ error: failure })
  })
  let done: ControlDonePayload
  try {
    // The async function constructor, reached through an instance because
    // `AsyncFunction` is not a global. The program body is strict-mode.
    /* v8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction(
      ...data.namespaces.map(namespace => namespace.global),
      ...errorClassParameters,
      'console',
      `'use strict';\n${data.code}`,
    )
    const value = await fn(...namespaces, ...errorClassValues, consoleShim)
    done = prepareCompletion(value, logs.remainingOutputBytes(), data.maxOutputBytes)
  } catch (error: unknown) {
    done = prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes)
  }
  meter.stop()
  if (!state.earlyDone) channel.sendDone(done)
}
