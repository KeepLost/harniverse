/**
 * CPython subprocess provider for the code-runtime seam. Each run owns one
 * fresh process and a hostile split control channel.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Duplex, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingNamespace, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, PROTOCOL_FD, validateChildFrame } from './protocol.ts'
import type { BootMessage, ChildToHost, HostToChild, ReplyMessage } from './protocol.ts'

/** Validated deployment limits and Python executable selection. */
export interface Config {
  /** Executable passed directly to `spawn`; no shell parses this value. */
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

interface LiveRun {
  settle(failure: CodeRunFailure): void
  finished: Promise<void>
}

function jsonCharacterBytes(character: string): number {
  const code = character.codePointAt(0) as number
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

function jsonStringBytesUpTo(text: string, maxBytes: number): number | undefined {
  let bytes = 2
  if (bytes > maxBytes) return undefined
  for (const character of text) {
    bytes += jsonCharacterBytes(character)
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

function truncateJsonString(text: string, maxBytes: number): string {
  let bytes = 2
  let end = 0
  for (const character of text) {
    const cost = jsonCharacterBytes(character)
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += character.length
  }
  return text.slice(0, end)
}

type JsonMeterTask = { value: unknown } | { key: string; value: unknown }

function* arrayMeterTasks(value: unknown[]): Generator<JsonMeterTask> {
  for (const item of value) yield { value: item }
}

function* objectMeterTasks(value: Record<string, unknown>): Generator<JsonMeterTask> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield { key, value: value[key] }
  }
}

function numberJson(value: number): string {
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value).toString() : String(value)
}

function jsonValueBytesUpTo(value: CodeJsonValue, maxBytes: number): number | undefined {
  let bytes = 0
  const cursors: Iterator<JsonMeterTask>[] = [[{ value }].values()]
  while (cursors.length > 0) {
    const cursor = cursors.at(-1) as Iterator<JsonMeterTask>
    const step = cursor.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    const task = step.value
    if ('key' in task) {
      const keyBytes = jsonStringBytesUpTo(task.key, maxBytes - bytes)
      if (keyBytes === undefined) return undefined
      bytes += keyBytes + 1
    }
    const current = task.value
    if (typeof current === 'string') {
      const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
      if (stringBytes === undefined) return undefined
      bytes += stringBytes
    } else if (typeof current === 'number') {
      bytes += Buffer.byteLength(numberJson(current), 'utf8')
    } else if (typeof current === 'boolean') {
      bytes += current ? 4 : 5
    } else if (current === null) {
      bytes += 4
    } else if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1)
      if (bytes + current.length > maxBytes) return undefined
      cursors.push(arrayMeterTasks(current))
    } else {
      const record = current as Record<string, unknown>
      let count = 0
      for (const key in record) if (Object.hasOwn(record, key)) count++
      bytes += 2 + Math.max(0, count - 1)
      if (bytes + count * 4 > maxBytes) return undefined
      cursors.push(objectMeterTasks(record))
    }
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

class OutputLedger {
  private bytes = 2
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  admit(text: string, sink: string[]): boolean {
    const separator = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separator)
    if (stringBytes === undefined) return false
    const cost = stringBytes + separator
    this.bytes += cost
    this.entries += 1
    sink.push(text)
    return true
  }

  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    const fullMessageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - fullMessageBytes
    for (const text of logs) {
      const separator = retained.length > 0 ? 1 : 0
      const available = logBudget - retainedBytes - separator
      if (available < 2) break
      const stringBytes = jsonStringBytesUpTo(text, available)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separator
        continue
      }
      const prefix = truncateJsonString(text, available)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, available) as number
        retained.push(prefix)
        retainedBytes += prefixBytes + separator
      }
      break
    }
    const message = truncateJsonString(fullMessage, this.maxBytes - retainedBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
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

function writeFrame(stream: Writable, frame: HostToChild, maxBytes = Number.POSITIVE_INFINITY): boolean {
  const encoded = `${encodeJsonPlain(frame)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) return false
  stream.write(encoded)
  return true
}

/** Fresh-process `ctx.codeRuntime` provider for Python 3.10 and newer. */
export class PythonCodeRuntime extends CodeRuntime {
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
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (this.config.pythonExecutable.trim().length === 0 || this.config.pythonExecutable.includes('\0')) {
      throw new Error('dsh-code-runtime-python: config.pythonExecutable must be a non-empty executable name or path')
    }
    for (const key of ['cpuSeconds', 'maxAddressSpaceMb', 'maxOutputBytes', 'maxControlBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`dsh-code-runtime-python: config.${key} must be a positive safe integer, got ${String(value)}`)
      }
    }
    if (!Number.isFinite(this.config.maxWallMs) || this.config.maxWallMs <= 0 || this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-python: config.maxWallMs must be a positive number at most ${MAX_TIMER_DELAY_MS}, got ${String(this.config.maxWallMs)}`)
    }
    if (this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-python: config.maxOutputBytes must be at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (this.config.maxAddressSpaceMb > Math.floor(Number.MAX_SAFE_INTEGER / MIB)) {
      throw new Error('dsh-code-runtime-python: config.maxAddressSpaceMb is too large to convert to bytes safely')
    }
    if (this.config.maxControlBytes < this.config.maxOutputBytes + 1024) {
      throw new Error('dsh-code-runtime-python: config.maxControlBytes must be at least maxOutputBytes + 1024')
    }
    ctx.effect(() => () => this.teardown(), 'python code-runtime teardown')
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
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-python: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return this.failureBeforeProcess({ kind: 'abort', message: 'run aborted' })
    }
    return await this.execute(request, bindings)
  }

  private failureBeforeProcess(error: CodeRunFailure): CodeRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }

    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-python: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-python: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-python: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-python: binding error member property ${JSON.stringify(member)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }

  private execute(request: CodeRunRequest, bindings: Map<string, CodeBindingNamespace>): Promise<CodeRunResult> {
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
      child = spawn(this.config.pythonExecutable, ['-I', '-B', BOOTSTRAP_PATH], {
        // Windows extra stdio pipes are not reliably duplex. stdin carries
        // Host frames; fd 3 carries child frames on every platform.
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: {},
        shell: false,
        windowsHide: true,
      })
    } catch {
      return Promise.resolve(this.failureBeforeProcess({ kind: 'worker-exit', message: 'python process could not start' }))
    }

    const input = child.stdin as Writable | null
    const stdout = child.stdout as Readable
    const stderr = child.stderr as Readable
    const protocol = child.stdio[PROTOCOL_FD] as Duplex | null
    if (input === null || protocol === null) {
      child.kill('SIGKILL')
      return Promise.resolve(this.failureBeforeProcess({ kind: 'worker-exit', message: 'python process control channel unavailable' }))
    }

    return new Promise<CodeRunResult>((resolve) => {
      let settling = false
      let state: 'booting' | 'running' = 'booting'
      const answered = new Set<number>()
      const logs: string[] = []
      const output = new OutputLedger(this.config.maxOutputBytes)
      let terminalOverride: CodeRunResult | undefined
      let closeSignal: NodeJS.Signals | null = null
      let closeResolve!: () => void
      const closed = new Promise<void>((done) => { closeResolve = done })
      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })

      const finalExitFailure = (): CodeRunFailure => closeSignal === 'SIGXCPU'
        ? { kind: 'timeout', message: `CPU budget exhausted (${this.config.cpuSeconds}s)` }
        : { kind: 'worker-exit', message: 'python process exited before completing' }

      const finish = (finalize: () => CodeRunResult): void => {
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
          const result = terminalOverride ?? finalized
          this.live.delete(live)
          finishResolve()
          resolve(result)
        })
      }

      const capture = (text: string): void => {
        if (terminalOverride !== undefined) return
        if (!output.admit(text, logs)) {
          terminalOverride = output.limit([...logs, text])
          finish(() => terminalOverride as CodeRunResult)
        }
      }
      stdout.on('data', (chunk: Buffer) => { capture(chunk.toString('utf8')) })
      stderr.on('data', (chunk: Buffer) => { capture(chunk.toString('utf8')) })

      const sendReply = (reply: ReplyMessage): void => {
        if (state !== 'running' || settling) return
        if (!writeFrame(input, reply, this.config.maxControlBytes)) {
          const fallback: ReplyMessage = { type: 'reply', id: reply.id, ok: false, message: 'binding resolution exceeded control limit' }
          writeFrame(input, fallback)
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
        void (async () => {
          try {
            const resolved = await fn(message.args)
            let value: CodeJsonValue | undefined
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
          }
        })()
      }

      const onFrame = (message: ChildToHost): void => {
        if (message.type === 'boot-ack') {
          if (state !== 'booting' || settling) return
          state = 'running'
          if (!writeFrame(input, { type: 'run', program: request.program }, this.config.maxControlBytes)) {
            finish(() => output.failure(logs, { kind: 'exception', message: 'program exceeds configured control limit' }))
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
          finish(() => output.failure(logs, error))
          return
        }
        if (message.value === undefined) {
          finish(() => output.success(logs))
          return
        }
        if (hasNonLosslessNumber(message.value)) {
          finish(() => output.failure(logs, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }))
          return
        }
        finish(() => output.success(logs, message.value as CodeJsonValue))
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
        () => { finish(() => output.failure(logs, { kind: 'worker-exit', message: 'python process violated the control protocol' })) },
      )
      protocol.on('data', (chunk: Buffer) => { reader.push(chunk) })
      protocol.on('error', () => {
        if (!settling) finish(() => output.failure(logs, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      })
      input.on('error', () => {
        if (!settling) finish(() => output.failure(logs, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      })

      child.once('error', () => {
        finish(() => output.failure(logs, { kind: 'worker-exit', message: 'python process could not start' }))
      })
      child.once('close', (_code, signal) => {
        closeSignal = signal
        closeResolve()
        if (!settling) finish(() => output.failure(logs, finalExitFailure()))
      })

      const onAbort = (): void => {
        finish(() => output.failure(logs, { kind: 'abort', message: 'run aborted' }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const wallTimer = setTimeout(() => {
        finish(() => output.failure(logs, { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)

      const live: LiveRun = {
        finished,
        settle: (failure) => { finish(() => output.failure(logs, failure)) },
      }
      this.live.add(live)

      try {
        if (!writeFrame(input, boot, this.config.maxControlBytes)) {
          finish(() => output.failure(logs, { kind: 'exception', message: 'binding metadata exceeds configured control limit' }))
        }
      } catch {
        finish(() => output.failure(logs, { kind: 'worker-exit', message: 'python process control channel unavailable' }))
      }
    })
  }
}

export * from './protocol.ts'
export default PythonCodeRuntime
