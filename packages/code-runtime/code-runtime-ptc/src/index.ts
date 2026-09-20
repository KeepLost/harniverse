/**
 * Fresh-process PTC code runtime: a fresh child process runs each host-type-stripped
 * TypeScript program and bridges bindings over the shared control channel
 * (`dsh-control-channel`) on the stdio pair. This is containment, not a security
 * boundary: model code has bash-equivalent trust despite an empty environment, a
 * heap cap, child-metered event-loop busy-time plus host-owned wall-clock budgets,
 * sandbox parity with the deployment's Bash policy, and forced termination that
 * also stops synchronous loops.
 * @module @deepseek-ai/dsh-code-runtime-ptc
 */

import { spawn } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingNamespace, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { ControlCallError, ControlChannelTransport, DEFAULT_CONTROL_CHANNEL_LIMITS } from '@deepseek-ai/dsh-control-channel'
import type { ControlFailure } from '@deepseek-ai/dsh-control-channel'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodeWorkerJson, encodeWorkerJson } from './json-wire.ts'

/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * Busy-time budget in milliseconds: the run fails with kind `'timeout'`
   * once the child's MEASURED event-loop active time
   * (`performance.eventLoopUtilization()`, sampled in-process) exceeds this.
   * Metering measured busy time — not wall time, not host-side pending-call
   * bookkeeping — is what makes the budget fair (a program awaiting a slow
   * tool accrues nothing). A hot synchronous loop starves the child's
   * sampler; the `maxWallMs` deadline is the backstop that stops it.
   */
  computeMs?: number
  /**
   * Wall-clock ceiling in milliseconds; never pauses for anything. The
   * backstop for what busy-time cannot see (a program awaiting a promise
   * nobody will resolve, or a loop blocking the child's sampling timer).
   * At most `2_147_483_647` (Node's maximum `setTimeout` delay, about 24.9
   * days): a longer value is rejected at load because `setTimeout` would
   * clamp it to 1 ms.
   */
  maxWallMs?: number
  /**
   * Hard cap for serialized log-array, completion-value, and failure-message payloads;
   * fixed result-envelope syntax is excluded.
   */
  maxOutputBytes?: number
  /** The child's max old-generation heap in MiB (`--max-old-space-size`); overflow kills the child, surfacing as kind `'worker-exit'`. */
  maxOldGenerationSizeMb?: number
}

/** {@link Config} after schemastery fills the defaults (every field present). */
type ResolvedConfig = Required<Config>

/** Smallest cap that can represent the counted payloads: an empty logs array plus an empty JSON failure message. */
const MIN_OUTPUT_BYTES = 4

/**
 * The seam's language-portable identifier subset (see
 * `CodeBindingNamespace.global`): no `$`, which is JS-only spelling — the same
 * namespace list must be usable against every backend regardless of language.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The shell a program is wrapped in for the type-strip, matching the
 * grammatical context it will execute in (an async function body, where
 * top-level `return` and `await` are legal — a bare module parse would
 * reject the `return`). Strip mode is position-preserving (removed syntax
 * becomes whitespace, nothing shifts), so the wrapper survives the strip
 * byte-identical and the body slices back out with the model's own
 * line/column positions intact.
 */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const

/** The target the host's opening control call names; the child serves exactly this one. */
const RUN_TARGET = 'run'

/**
 * Headroom subtracted from the channel's frame bound to derive the per-entry
 * log cap the child truncates against: the JSON wrapper around the text plus
 * escaping slack, so one admitted entry always encodes within `maxFrameBytes`.
 */
const LOG_FRAME_HEADROOM_BYTES = 1_024

/** One in-flight run's host-side state, tracked for disposal. */
interface LiveRun {
  finished: Promise<CodeRunResult>
  settle(failure: CodeRunFailure): void
}

/** Render an unknown thrown value as a message, `Error` or not. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- the strip API throws Error instances; the String arm is a defensive render. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * The child entry path. Source runs unbuilt (`src/child.ts`, loadable
 * directly on this repo's Node range via native type stripping — the file
 * is erasable-only with type-only relative imports); the built package
 * ships it as a sibling CommonJS bundle (`lib/child.cjs`, its own tsdown
 * entry) because pkg's VFS child-process hook compiles string-path entries
 * as CommonJS.
 * The URL *pathname*'s extension says which world this module is in —
 * pathname, because dev-time module runners (vitest) may suffix
 * `import.meta.url` with a query string; relative resolution drops it.
 */
/* v8 ignore next -- the './child.cjs' arm is the built-lib world, unreachable unbuilt by construction; the built-lib e2e pins it. */
const CHILD_PATH = fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './child.ts' : './child.cjs', import.meta.url))

/** One run's combined outer-output ledger; binding values never enter it. */
class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    /* v8 ignore next -- the child's ledger already rejects oversized completions; the host arm is a defensive trust boundary. */
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /** Build the explicit output-limit failure while retaining a fitting prefix of the final log. */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    // The fixed diagnostic is ASCII, so every character is one byte plus the quotes.
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

/**
 * The shipped {@link CodeRuntime} backend (`ctx.codeRuntime`). Registers as
 * the `codeRuntime` service; every cap comes from validated config. See the
 * module doc for the containment model and the Service Definition's class JSDoc for
 * the contract this implements (error-as-field, hostile-peer channel,
 * no cross-run state, dispose to quiescence).
 */
export class PtcCodeRuntime extends CodeRuntime {
  static inject = ['sandboxPolicy']
  static Config: z<Config> = z.object({
    computeMs: z.number().default(60_000),
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
  })

  readonly language = 'typescript'
  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery filled the defaults; the cast records that. Positivity is a
    // semantic check the schema's plain number type does not carry.
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) throw new Error(`dsh-code-runtime-ptc: config.${key} must be a positive number, got ${String(value)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-ptc: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    // maxWallMs reaches setTimeout, which clamps any delay above
    // MAX_TIMER_DELAY_MS to 1 ms; the positivity check above accepts such a
    // value, so a 25-day ceiling would time the run out immediately.
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-ptc: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms), got ${String(this.config.maxWallMs)}`)
    }
    ctx.effect(() => () => { void this.teardown() }, 'PTC code-runtime teardown')
  }

  /**
   * Dispose to quiescence: mark the service unusable, cancel every in-flight
   * run as aborted, and AWAIT each child's exit so no process outlives the
   * fiber.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(run => run.finished))
  }

  /**
   * Execute one program in a fresh child process. Program outcomes — including a
   * type-strip syntax error, which never spawns a process — resolve with
   * `result.error`; the method rejects only for Service Definition contract misuse (a disposed
   * runtime, an invalid binding namespace) and when the deployment's sandbox
   * policy is confined but no sandbox backend can start, which fails closed
   * like the Bash family's spawn path.
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-ptc: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return this.failureBeforeChild({ kind: 'abort', message: String(request.signal.reason) })
    }

    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      // A program that does not survive the type-strip (syntax error,
      // non-erasable syntax like `enum`) is a program failure, reported the
      // same way a thrown exception would be — and no child ever spawns.
      return this.failureBeforeChild({ kind: 'exception', message: messageOf(error) })
    }

    return await this.execute(request, code, bindings)
  }

  /** Apply the outer-output ledger to failures that occur before a child owns one. */
  private failureBeforeChild(error: CodeRunFailure): CodeRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  /** Reject malformed binding globals or typed-error declarations as Service Definition contract misuse. */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-ptc: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      // RESERVED_BINDING_GLOBALS is the seam's shared backend-owned set:
      // the dunder entries exist for the Python side — its seeded/wrapped
      // slots plus the `__debug__` compile-time constant — refused here so
      // the namespace list stays portable across backends, and `console` is
      // reserved for this backend's log-capture shim. The seam declaration
      // is the single home for why each entry is reserved.
      if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-ptc: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-ptc: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }

    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-ptc: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-ptc: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-ptc: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-ptc: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }

  /**
   * Wrap the child argv for the deployment's resolved sandbox policy — the
   * same parity the Bash family applies at spawn: confined modes require a
   * `ctx.sandbox` provider and fail closed without one, while
   * `danger-full-access` runs the raw argv. The resolved policy also fixes
   * the child's cwd (the workspace-write boundary).
   */
  private spawnPlan(): { argv: string[]; cwd: string } {
    const policy = this.ctx.sandboxPolicy.resolve()
    const argv = [process.execPath, `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`, CHILD_PATH]
    const mode = policy.mode
    if (mode === 'danger-full-access') return { argv, cwd: policy.workspaceRoot }
    const sandbox = this.ctx.get('sandbox')
    if (sandbox === undefined) {
      throw new SandboxUnavailableError(mode)
    }
    return { argv: sandbox.confine(argv, { ...policy, mode }).argv, cwd: policy.workspaceRoot }
  }

  /** Spawn the child for one validated, type-stripped run and drive it to settlement. */
  private execute(
    request: CodeRunRequest,
    code: string,
    bindings: Map<string, CodeBindingNamespace>,
  ): Promise<CodeRunResult> {
    // Sandbox refusal (confined mode without a provider) fails closed here,
    // exactly like the Bash family's spawn path — before any process exists.
    const { argv, cwd } = this.spawnPlan()
    // Model code gets NO ambient environment — stronger than the scrubbed
    // env the defensive-patterns rule requires for spawned commands — and
    // hermetic flags: the argv is built from scratch (heap cap plus entry),
    // so a test runner's or tsx's loader hooks never leak into the child.
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const logs: string[] = []
    const strayLogs: string[] = []
    const output = new OutputLedger(this.config.maxOutputBytes)
    let terminalOverride: CodeRunResult | undefined

    // Pipe delivery is independent of frame traffic. Continue bounded pipe
    // capture after the terminal frame while child termination drains bytes
    // that were already queued; the finalize step materializes the result
    // only after termination completes. A native-level write past the
    // patched stream slots lands here (the child's channel corrupts on
    // fd-1 writes, so stderr is the only stray source in practice).
    const captureStray = (chunk: Buffer): void => {
      /* v8 ignore next -- a second post-overflow chunk races immediate child termination; the first overflow path is covered. */
      if (terminalOverride !== undefined) return
      const text = chunk.toString('utf8')
      if (!output.admit(text, strayLogs)) {
        const limited = output.limit([...logs, ...strayLogs, text])
        terminalOverride = limited
      }
    }
    child.stderr.on('data', captureStray)

    const maxLogFrameBytes = DEFAULT_CONTROL_CHANNEL_LIMITS.maxFrameBytes - LOG_FRAME_HEADROOM_BYTES
    const transport = new ControlChannelTransport({
      input: child.stdout,
      output: child.stdin,
      ...request.signal === undefined ? {} : { signal: request.signal },
      deadlineMs: this.config.maxWallMs,
      forceTerminate: () => { child.kill('SIGKILL') },
      handlers: {
        onLog: (text) => {
          /* v8 ignore next -- the child stops emitting log frames once its own ledger truncates; post-override frames cannot arrive. */
          if (terminalOverride !== undefined) return
          /* v8 ignore next 3 -- the child's own ledger caps combined bytes first; the host admit failure is a defensive trust boundary. */
          if (!output.admit(text, logs)) {
            terminalOverride = output.limit([...logs, ...strayLogs, text])
          }
        },
        onLimit: (limit) => {
          /* v8 ignore next 3 -- the child emits output limits eagerly; the pending-calls arm is a defensive trust boundary. */
          if (limit === 'output' && terminalOverride === undefined) {
            terminalOverride = output.limit([...logs, ...strayLogs])
          }
        },
        onCall: async (frame) => {
          const target = frame.target
          /* v8 ignore next 3 -- the child only emits well-formed binding targets;
           * malformed-frame handling is a defensive trust boundary. */
          if (!target.startsWith('binding:')) throw new Error(`unknown call target ${JSON.stringify(target)}`)
          const separator = target.indexOf(':', 'binding:'.length)
          /* v8 ignore next 1 */
          if (separator === -1) throw new Error(`unknown call target ${JSON.stringify(target)}`)
          const global = target.slice('binding:'.length, separator)
          const name = target.slice(separator + 1)
          const record = bindings.get(global)?.functions
          // Own-property lookup only: a forged name like 'constructor' or
          // 'hasOwnProperty' must not walk the record's prototype chain and
          // reach a callable the consumer never declared.
          const fn = record && Object.hasOwn(record, name) ? record[name] : undefined
          if (typeof fn !== 'function') {
            throw new Error(`unknown binding ${JSON.stringify(`${global}.${name}`)}`)
          }
          const wireArgs = frame.args[0]
          const args = decodeWorkerJson(wireArgs)
          /* v8 ignore next 1 -- the child pre-encodes arguments; undecodable wire args mean a peer bug. */
          if (args === undefined) throw new Error('binding arguments must be lossless JSON')
          const resolved = await fn(args)
          let value: CodeJsonValue | undefined
          try {
            value = snapshotJsonValue(resolved)
          } catch {
            value = undefined
          }
          if (value === undefined) throw new Error('binding resolution must be lossless JSON')
          return encodeWorkerJson(value)
        },
      },
    })

    // Exactly one outcome wins: the child's done frame (value or failure) or
    // the transport's terminal classification (deadline, abort, channel
    // death). Every path waits for settlement, disposes the transport, and
    // awaits the child's exit; logs captured before timeout, abort, or
    // failure remain in the result.
    const finished = (async (): Promise<CodeRunResult> => {
      try {
        // Boot-ack semantics: the reply confirms the child accepted the
        // program; the run's outcome arrives as the done frame. A rejection
        // here means the channel terminated first and the catch path owns it.
        await transport.call(RUN_TARGET, [
          code,
          [...bindings].map(([global, namespace]) => ({
            global,
            names: Object.keys(namespace.functions),
            ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
          })),
          this.config.maxOutputBytes,
          this.config.computeMs,
          maxLogFrameBytes,
        ])
        const outcome = await transport.outcome()
        // The host-side output ledger already built the terminal result when
        // an overflowing entry crossed it; that classification wins.
        if (terminalOverride !== undefined) return terminalOverride
        if (outcome.kind === 'value') {
          // The child sends done without a value exactly when the program
          // completed without one; present values are always wire-encodable
          // (prepareCompletion rejects anything else child-side).
          if (outcome.value === undefined) return output.success([...logs, ...strayLogs])
          const value = decodeWorkerJson(outcome.value)
          /* v8 ignore next 3 -- the child only sends encodable completions; an undecodable done is a peer bug. */
          return value === undefined
            ? output.failure([...logs, ...strayLogs], { kind: 'invalid-output', message: 'program completion must be lossless JSON' })
            : output.success([...logs, ...strayLogs], value)
        }
        return output.failure([...logs, ...strayLogs], this.mapFailure(outcome.failure))
      } catch (cause) {
        // A denial-shaped rejection (the child refused the boot payload) is a
        // host-side contract violation: surface it loudly rather than mapping
        // it onto the run. Everything else means the channel terminated first
        // and the outcome below owns the result — never a host crash.
        /* v8 ignore next 2 -- a boot denial means OUR child refused OUR payload: unreachable without a host bug. */
        if (cause instanceof ControlCallError && cause.failure.kind === 'exception') throw cause
        const outcome = await transport.outcome()
        /* v8 ignore next 5 -- the override and value arms require a child that
         * settles after failing the boot call; our child never does. */
        if (terminalOverride !== undefined) return terminalOverride
        return output.failure(
          [...logs, ...strayLogs],
          /* v8 ignore next 3 -- the value arm needs a child that settles after failing its own boot; ours never does. */
          outcome.kind === 'value'
            ? { kind: 'worker-exit', message: 'child settled without a terminal outcome' }
            : this.mapFailure(outcome.failure),
        )
      } finally {
        await transport.waitSettled()
        const cleanupNotes = await transport.dispose()
        /* v8 ignore next 1 -- notes appear only when the transport had to force-terminate a broken peer. */
        for (const note of cleanupNotes) this.ctx.logger.warn(`dsh-code-runtime-ptc: ${note}`)
        // A settled child exits on its own; a hostile one blocked on a full
        // pipe gets the same close-grace escalation, then a guaranteed kill.
        /* v8 ignore next 15 -- the suites' children always exit within the close
         * grace; the alive-wait and kill escalation are last-resort containment. */
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            /* v8 ignore next -- the backstop fires only for a child that outlives the close grace; the suites' children never do. */
            const killer = setTimeout(() => { child.kill('SIGKILL') }, DEFAULT_CONTROL_CHANNEL_LIMITS.closeGraceMs)
            child.once('exit', () => {
              clearTimeout(killer)
              resolve()
            })
          })
        }
      }
    })()

    const live: LiveRun = {
      finished,
      settle: (failure) => { transport.cancel(failure.message) },
    }
    this.live.add(live)
    void finished.then(() => { this.live.delete(live) })
    return finished
  }

  /** Translate one control-channel failure into the seam's failure vocabulary. */
  private mapFailure(failure: ControlFailure): CodeRunFailure {
    if (failure.kind === 'exception' || failure.kind === 'invalid-output' || failure.kind === 'output-limit'
      || failure.kind === 'timeout' || failure.kind === 'abort') {
      return { kind: failure.kind, message: failure.message }
    }
    // process-exit, io, protocol, sandbox-unavailable: the substrate died or
    // broke its framing — one vocabulary entry for the seam's callers.
    return { kind: 'worker-exit', message: failure.message }
  }
}

export default PtcCodeRuntime
