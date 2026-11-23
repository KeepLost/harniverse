/**
 * CPython subprocess provider for the ptc-runtime seam. Each run owns one
 * fresh process and a hostile split control channel.
 */

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PtcRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcJsonValue, PtcOutput, PtcRunFailure, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, PROTOCOL_FD, validateChildFrame } from './protocol.ts'
import { OutputLedger } from './output-ledger.ts'
import type { BootMessage, ChildToHost, HostToChild, ReplyMessage } from './protocol.ts'

/** Validated deployment limits and Python executable selection. */
export interface Config {
  /**
   * Python interpreter resolved at plugin load: an absolute or relative path
   * to an executable regular file, or a bare name searched on the Host `PATH`.
   * The resolved file must report CPython 3.10 or newer in an isolated probe.
   */
  pythonExecutable?: string
  /** Per-process `RLIMIT_CPU` soft limit in whole seconds where supported. */
  cpuSeconds?: number
  /** Host wall-clock ceiling for one complete process run. */
  maxWallMs?: number
  /** Per-process `RLIMIT_AS` soft limit in MiB where supported. */
  maxAddressSpaceMb?: number
  /** Combined serialized logs/value/diagnostic cap. */
  maxOutputBytes?: number
  /** Maximum bytes in one control frame, including binding payloads. */
  maxControlBytes?: number
}

type ResolvedConfig = Required<Config>

const BOOTSTRAP_PATH = fileURLToPath(new URL('../py/bootstrap.py', import.meta.url))
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const MIN_OUTPUT_BYTES = 4
const MIB = 1024 * 1024
/** Bound for in-flight binding calls and unflushed reply frames per run. */
const MAX_PENDING_BINDING_WORK = 1024
/** Wall-clock bound for one load-time interpreter probe. */
const PYTHON_PROBE_TIMEOUT_MS = 5_000
/** Probe output beyond this many bytes is treated as a failed probe. */
const PYTHON_PROBE_MAX_BUFFER_BYTES = 1_024
const PYTHON_PROBE_SOURCE = 'import sys; print(sys.implementation.name, sys.version_info.major, sys.version_info.minor, sys.version_info.micro)'
const PYTHON_PROBE_OUTPUT = /^(\S+) (\d+) (\d+) (\d+)$/

interface LiveRun {
  settle(failure: PtcRunFailure): void
  finished: Promise<void>
}

/**
 * Snapshot of one caller-supplied namespace captured during validation. Every
 * descriptor property is read exactly once, so later stages cannot observe
 * swapped or re-throwing getters, and member lookup stays own-property only.
 */
interface ValidatedNamespace {
  functions: Record<string, PtcBindingFunction>
  errorClass?: { name: string; memberNameProperty: string }
}

function executableFile(candidate: string): string | undefined {
  try {
    accessSync(candidate, fsConstants.X_OK)
    if (statSync(candidate).isFile()) return candidate
  } catch {
    // Missing or unreadable candidates are simply not executable files.
  }
  return undefined
}

function containsPathSeparator(executable: string, platform: NodeJS.Platform): boolean {
  return executable.includes('/') || (platform === 'win32' && executable.includes('\\'))
}

/**
 * Resolve a configured executable to an executable regular file. Absolute
 * paths are checked directly, separator-bearing paths resolve against the
 * working directory, and bare names scan Host `PATH` entries (trying the
 * `.exe` suffix on Windows).
 * @param executable - Configured executable name or path.
 * @param pathEnvironment - `PATH` value used for bare-name lookup.
 * @param platform - Host platform; injectable for deterministic cross-platform tests.
 * @returns The resolved executable path, or undefined when nothing matches.
 */
export function resolvePythonExecutable(
  executable: string,
  pathEnvironment: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (isAbsolute(executable)) return executableFile(executable)
  if (containsPathSeparator(executable, platform)) return executableFile(resolve(executable))
  const names = platform === 'win32' ? [executable, `${executable}.exe`] : [executable]
  for (const entry of pathEnvironment?.split(delimiter) ?? []) {
    if (!isAbsolute(entry)) continue
    for (const name of names) {
      const candidate = executableFile(join(entry, name))
      if (candidate !== undefined) return candidate
    }
  }
  return undefined
}

function probePythonExecutable(resolved: string): void {
  let output: string
  try {
    output = execFileSync(resolved, ['-I', '-c', PYTHON_PROBE_SOURCE], {
      encoding: 'utf8',
      env: { TMPDIR: tmpdir() },
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: PYTHON_PROBE_MAX_BUFFER_BYTES,
    }).trim()
  } catch (error) {
    throw new Error(`dsh-ptc-runtime-python: config.pythonExecutable ${JSON.stringify(resolved)} failed the CPython version probe: ${error instanceof Error ? error.message : String(error)}`)
  }
  const match = PYTHON_PROBE_OUTPUT.exec(output)
  if (match === null) {
    throw new Error(`dsh-ptc-runtime-python: config.pythonExecutable ${JSON.stringify(resolved)} did not report a CPython version`)
  }
  const implementation = match[1] as string
  const major = Number(match[2])
  const minor = Number(match[3])
  if (implementation !== 'cpython') {
    throw new Error(`dsh-ptc-runtime-python: config.pythonExecutable ${JSON.stringify(resolved)} must be CPython, got ${implementation}`)
  }
  if (major < 3 || (major === 3 && minor < 10)) {
    throw new Error(`dsh-ptc-runtime-python: config.pythonExecutable ${JSON.stringify(resolved)} must be CPython 3.10 or newer, got cpython ${major}.${minor}.${String(match[4])}`)
  }
}


class JsonLineReader {
  private readonly parts: Buffer[] = []
  private bytes = 0
  private failed = false

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.failed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.parts.push(part)
      this.bytes += part.length
      if (this.bytes > this.maxBytes) {
        this.failed = true
        this.parts.length = 0
        this.onOverflow()
        return
      }
      if (newline === -1) return
      const bytes = Buffer.concat(this.parts, this.bytes)
      this.parts.length = 0
      this.bytes = 0
      try {
        this.onLine(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        // Invalid UTF-8 is hostile junk, not a string with replacement bytes.
      }
      offset = newline + 1
    }
  }
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9_.~@%+,:=-]+)+/g, ' <path>')
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>')
    .slice(0, 4096)
}

function writeFrame(stream: Writable, frame: HostToChild, maxBytes = Number.POSITIVE_INFINITY, onFlush?: () => void): boolean {
  const encoded = `${encodeJsonPlain(frame)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) return false
  stream.write(encoded, () => onFlush?.())
  return true
}

/**
 * Fresh-process `ctx.ptcRuntime` provider for Python 3.10 and newer. The
 * configured interpreter is resolved and probed once at plugin load; every
 * run spawns that exact file in a new process.
 */
/** The fixed execution directory reported by resolve: the fresh-process substrate owns no working directory. */
const PTC_PYTHON_CWD = process.cwd()

/**
 * CPython subprocess provider for the PTC runtime seam: one fresh process per
 * run over the fd-3 split control channel, resolving each call against the
 * configured wall-clock budget.
 */
export class PythonPtcRuntime extends PtcRuntime {
  static Config: z<Config> = z.object({
    pythonExecutable: z.string().default('python3'),
    cpuSeconds: z.number().default(60),
    maxWallMs: z.number().default(600_000),
    maxAddressSpaceMb: z.number().default(512),
    maxOutputBytes: z.number().default(67_108_864),
    maxControlBytes: z.number().default(67_109_888),
  })

  readonly language = 'python'
  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly executable: string
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (this.config.pythonExecutable.trim().length === 0 || this.config.pythonExecutable.includes('\0')) {
      throw new Error('dsh-ptc-runtime-python: config.pythonExecutable must be a non-empty executable name or path')
    }
    for (const key of ['cpuSeconds', 'maxAddressSpaceMb', 'maxOutputBytes', 'maxControlBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`dsh-ptc-runtime-python: config.${key} must be a positive safe integer, got ${String(value)}`)
      }
    }
    if (!Number.isFinite(this.config.maxWallMs) || this.config.maxWallMs <= 0 || this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-ptc-runtime-python: config.maxWallMs must be a positive number at most ${MAX_TIMER_DELAY_MS}, got ${String(this.config.maxWallMs)}`)
    }
    if (this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-ptc-runtime-python: config.maxOutputBytes must be at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (this.config.maxAddressSpaceMb > Math.floor(Number.MAX_SAFE_INTEGER / MIB)) {
      throw new Error('dsh-ptc-runtime-python: config.maxAddressSpaceMb is too large to convert to bytes safely')
    }
    if (this.config.maxControlBytes < this.config.maxOutputBytes + 1024) {
      throw new Error('dsh-ptc-runtime-python: config.maxControlBytes must be at least maxOutputBytes + 1024')
    }
    const configured = this.config.pythonExecutable
    const executable = resolvePythonExecutable(configured)
    if (executable === undefined) {
      const explicit = isAbsolute(configured) || containsPathSeparator(configured, process.platform)
      throw new Error(`dsh-ptc-runtime-python: config.pythonExecutable ${JSON.stringify(configured)} ${explicit ? 'is not an executable file' : 'does not resolve to an executable file on PATH'}`)
    }
    probePythonExecutable(executable)
    this.executable = executable
    ctx.effect(() => () => this.teardown(), 'Python PTC runtime teardown')
  }

  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(run => run.finished))
  }

  /**
   * Run one program in a fresh Python process. Program and process outcomes
   * resolve as result errors; rejection is reserved for service-contract misuse.
   * @param request - Python source, portable bindings, and optional abort signal.
   * @returns The bounded completion, logs, or normalized failure.
   */
  /**
   * Resolve supported options and provider defaults before execution: the
   * fresh-process substrate carries no execution directory of its own, so the
   * request's directory choice is optional and every budget choice is
   * provider-fixed (a per-call override is unsupported and rejects).
   * @param request - Python source, portable bindings, and optional abort signal.
   * @returns The complete spec for run.
   * @throws When an explicit timeout or policy choice is supplied.
   */
  override resolve(request: PtcRunRequest): PtcRunSpec {
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) {
      throw new Error('dsh-ptc-runtime-python: per-call timeoutMs is not supported')
    }
    if (request.sandboxPolicy !== undefined) {
      throw new Error('dsh-ptc-runtime-python: per-call sandbox policies are not supported')
    }
    return { ...request, cwd: PTC_PYTHON_CWD, timeoutMs: this.config.maxWallMs }
  }

  /**
   * Run one resolved program in a fresh Python process. Program and process outcomes
   * resolve as result errors; rejection is reserved for service-contract misuse.
   * @param spec - Python source, portable bindings, and optional abort signal.
   * @returns The bounded completion, logs, or normalized failure.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('dsh-ptc-runtime-python: run() after disposal')
    // This runtime spawns through the host child_process; a remote execution
    // world would decide an argv this host then executes, so it fails closed
    // before any child exists (in-world execution is future substrate work).
    if (this.ctx.get('subprocess')?.locality === 'remote') {
      throw new Error('dsh-ptc-runtime-python: run() requires a local execution world (this substrate spawns on the host; refusing a remote execution world)')
    }
    const bindings = this.validateBindings(spec)
    if (spec.signal?.aborted) {
      return this.failureBeforeProcess({ kind: 'abort', message: 'run aborted' })
    }
    return await this.execute(spec, bindings)
  }

  private failureBeforeProcess(error: PtcRunFailure): PtcRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  private validateBindings(request: PtcRunRequest): Map<string, ValidatedNamespace> {
    const bindings = new Map<string, ValidatedNamespace>()
    for (const namespace of request.bindings) {
      const global = namespace.global
      if (!IDENTIFIER.test(global) || PORTABLE_RESERVED_WORDS.has(global)) {
        throw new Error(`dsh-ptc-runtime-python: binding global ${JSON.stringify(global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(global)) {
        throw new Error(`dsh-ptc-runtime-python: reserved binding global ${JSON.stringify(global)}`)
      }
      if (bindings.has(global)) {
        throw new Error(`dsh-ptc-runtime-python: duplicate binding global ${JSON.stringify(global)}`)
      }
      const supplied = namespace.functions
      const functions = Object.create(null) as Record<string, PtcBindingFunction>
      for (const name of Object.keys(supplied)) {
        const fn = supplied[name]
        if (typeof fn === 'function') functions[name] = fn
      }
      const descriptor = namespace.errorClass
      bindings.set(global, {
        functions,
        ...descriptor ? { errorClass: { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty } } : {},
      })
    }

    const errorClassNames = new Set<string>()
    for (const namespace of bindings.values()) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-ptc-runtime-python: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
        throw new Error(`dsh-ptc-runtime-python: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-ptc-runtime-python: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-ptc-runtime-python: binding error member property ${JSON.stringify(member)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }

  private execute(request: PtcRunSpec, bindings: Map<string, ValidatedNamespace>): Promise<PtcRunResult> {
    const boot: BootMessage = {
      type: 'boot',
      cpuSeconds: this.config.cpuSeconds,
      addressSpaceBytes: this.config.maxAddressSpaceMb * MIB,
      maxOutputBytes: this.config.maxOutputBytes,
      maxControlBytes: this.config.maxControlBytes,
      namespaces: [...bindings].map(([global, namespace]) => ({
        global,
        names: Object.keys(namespace.functions),
        ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
      })),
    }

    let child: ChildProcess
    try {
      const path = process.env.PATH
      child = spawn(this.executable, ['-I', '-B', BOOTSTRAP_PATH], {
        // Windows extra stdio pipes are not reliably duplex. stdin carries
        // Host frames; fd 3 carries child frames on every platform.
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        // Only PATH crosses into the child; the interpreter itself was
        // resolved and probed once at load, and the bootstrap clears its
        // environment before model code runs.
        env: path === undefined ? {} : { PATH: path },
        shell: false,
        windowsHide: true,
      })
    } catch {
      return Promise.resolve(this.failureBeforeProcess({ kind: 'worker-exit', message: 'python process could not start' }))
    }

    const input = child.stdin
    const stdout = child.stdout as Readable
    const stderr = child.stderr as Readable
    const protocol = child.stdio[PROTOCOL_FD] as Duplex | null
    if (input === null || protocol === null) {
      child.kill('SIGKILL')
      return Promise.resolve(this.failureBeforeProcess({ kind: 'worker-exit', message: 'python process control channel unavailable' }))
    }

    return new Promise<PtcRunResult>((resolve) => {
      let settling = false
      let state: 'booting' | 'running' = 'booting'
      const answered = new Set<number>()
      let pendingReplies = 0
      let pendingCalls = 0
      const output: PtcOutput[] = []
      const ledger = new OutputLedger(this.config.maxOutputBytes)
      let truncated = false
      let closeSignal: NodeJS.Signals | null = null
      let closeResolve!: () => void
      const closed = new Promise<void>((done) => { closeResolve = done })
      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })

      const finalExitFailure = (): PtcRunFailure => closeSignal === 'SIGXCPU'
        ? { kind: 'timeout', message: `CPU budget exhausted (${this.config.cpuSeconds}s)` }
        : { kind: 'worker-exit', message: 'python process exited before completing' }

      const finish = (finalize: () => PtcRunResult): void => {
        /* v8 ignore next -- re-entrant finish is guarded by every caller's settle check. */
        if (settling) return
        settling = true
        clearTimeout(wallTimer)
        request.signal?.removeEventListener('abort', onAbort)
        try {
          input.end()
        } catch {
          // The child may have closed stdin first; process exit remains authoritative.
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        void closed.then(() => {
          const finalized = finalize()
          this.live.delete(live)
          finishResolve()
          resolve(finalized)
        })
      }

      const capture = (text: string): void => {
        if (truncated) return
        if (!ledger.admit({ type: 'text', text }, output)) truncated = true
      }
      stdout.on('data', (chunk: Buffer) => { capture(chunk.toString('utf8')) })
      stderr.on('data', (chunk: Buffer) => { capture(chunk.toString('utf8')) })

      const sendReply = (reply: ReplyMessage): void => {
        if (state !== 'running' || settling) return
        if (pendingReplies >= MAX_PENDING_BINDING_WORK) {
          finish(() => ledger.failure(output, { kind: 'worker-exit', message: `reply backlog exceeded ${MAX_PENDING_BINDING_WORK} frames the child has not consumed on stdin` }))
          return
        }
        pendingReplies += 1
        const onFlush = (): void => { pendingReplies -= 1 }
        if (!writeFrame(input, reply, this.config.maxControlBytes, onFlush)) {
          const fallback: ReplyMessage = { type: 'reply', id: reply.id, ok: false, message: 'binding resolution exceeded control limit' }
          writeFrame(input, fallback, this.config.maxControlBytes, onFlush)
        }
      }

      const onCall = (message: ChildToHost): void => {
        if (message.type !== 'call' || state !== 'running' || settling || answered.has(message.id)) return
        answered.add(message.id)
        const record = bindings.get(message.global)?.functions
        const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
        if (typeof fn !== 'function') {
          sendReply({ type: 'reply', id: message.id, ok: false, message: 'unknown binding' })
          return
        }
        if (pendingCalls >= MAX_PENDING_BINDING_WORK) {
          finish(() => ledger.failure(output, { kind: 'worker-exit', message: `call backlog exceeded ${MAX_PENDING_BINDING_WORK} in-flight binding calls (a binding never settled)` }))
          return
        }
        pendingCalls += 1
        void (async () => {
          try {
            const resolved = await fn(message.args)
            let value: PtcJsonValue | undefined
            try {
              value = snapshotJsonValue(resolved)
            } catch {
              value = undefined
            }
            if (value === undefined) {
              sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
            } else {
              sendReply({ type: 'reply', id: message.id, ok: true, value })
            }
          } catch {
            sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding call failed' })
          } finally {
            pendingCalls -= 1
          }
        })()
      }

      const onFrame = (message: ChildToHost): void => {
        if (message.type === 'boot-ack') {
          if (state !== 'booting' || settling) return
          state = 'running'
          if (!writeFrame(input, { type: 'run', program: request.program, ...request.discardCompletion === true ? { discardCompletion: true } : {} }, this.config.maxControlBytes)) {
            finish(() => ledger.failure(output, { kind: 'exception', message: 'program exceeds configured control limit' }))
          }
          return
        }
        if (message.type === 'log') {
          if (state === 'running' && !settling) capture(message.text)
          return
        }
        if (message.type === 'call') {
          onCall(message)
          return
        }
        if (state !== 'running' || settling) return
        if (message.error) {
          const error = { ...message.error, message: sanitizeDiagnostic(message.error.message) }
          finish(() => ledger.failure(output, error))
          return
        }
        if (message.value === undefined) {
          finish(() => ledger.success(output))
          return
        }
        if (hasNonLosslessNumber(message.value)) {
          finish(() => ledger.failure(output, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }))
          return
        }
        finish(() => ledger.success(output, message.value as PtcJsonValue))
      }

      const reader = new JsonLineReader(
        this.config.maxControlBytes,
        (line) => {
          if (hasUnsafeIntegerToken(line)) return
          let raw: unknown
          try {
            raw = JSON.parse(line)
          } catch {
            return
          }
          const message = validateChildFrame(raw)
          if (message) onFrame(message)
        },
        () => { finish(() => ledger.failure(output, { kind: 'worker-exit', message: 'python process violated the control protocol' })) },
      )
      protocol.on('data', (chunk: Buffer) => { reader.push(chunk) })
      protocol.on('error', () => {
        if (!settling) finish(() => ledger.failure(output, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      })
      input.on('error', () => {
        if (!settling) finish(() => ledger.failure(output, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      })

      child.once('error', () => {
        finish(() => ledger.failure(output, { kind: 'worker-exit', message: 'python process could not start' }))
      })
      child.once('close', (_code, signal) => {
        closeSignal = signal
        closeResolve()
        if (!settling) finish(() => ledger.failure(output, finalExitFailure()))
      })

      const onAbort = (): void => {
        finish(() => ledger.failure(output, { kind: 'abort', message: 'run aborted' }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const wallTimer = setTimeout(() => {
        finish(() => ledger.failure(output, { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)

      const live: LiveRun = {
        finished,
        settle: (failure) => { finish(() => ledger.failure(output, failure)) },
      }
      this.live.add(live)

      try {
        if (!writeFrame(input, boot, this.config.maxControlBytes)) {
          finish(() => ledger.failure(output, { kind: 'exception', message: 'binding metadata exceeds configured control limit' }))
        }
      } catch {
        finish(() => ledger.failure(output, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      }
    })
  }
}

export * from './protocol.ts'
export default PythonPtcRuntime
