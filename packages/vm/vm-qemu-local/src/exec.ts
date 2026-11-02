/**
 * Exec surface over the control channel: start guest processes with plain
 * pipes or a pty, stream their output as events, feed stdin, deliver
 * signals, and collect or bound results. Every exec is one id; output and
 * exit events for that id belong to the handle that claimed it.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { isOpReplyFor, parseGuestMessage, type ControlTransport, type ExecMessage, type HostMessage } from './protocol.ts'

/** Largest decoded stdin chunk one wire message may carry (mirrors the guest cap). */
export const MAX_STDIN_CHUNK_BYTES = 512 * 1024

/** Default collection bound for `exec` results. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Reply deadline for the exec start ack and signal acks. */
const OP_REPLY_TIMEOUT_MS = 10_000

/** Default pty size when `pty: true` requests no explicit geometry. */
const DEFAULT_PTY: { rows: number; cols: number } = { rows: 24, cols: 80 }

/** The guest rejected an exec request or a signal delivery. */
export class ExecStartError extends Error {
  constructor(
    public readonly execId: number,
    public readonly guestMessage: string,
  ) {
    super(`guest rejected exec ${execId}: ${guestMessage}`)
    this.name = 'ExecStartError'
  }
}

/** Host-side validation of exec options failed before anything was sent. */
export class ExecOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecOptionsError'
  }
}

/** Collected output exceeded the configured bound; the exec was killed. */
export class ExecOutputLimitError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`exec output exceeded ${limitBytes} bytes`)
    this.name = 'ExecOutputLimitError'
  }
}

/** Options shared by the collecting `exec` and the streaming `spawn`. */
export interface ExecOptions {
  /** Environment for the child; replaces the guest default entirely. */
  env?: Record<string, string>
  /** Absolute working directory; default `/`. */
  cwd?: string
  /** Allocate a pty (stderr then merges into stdout on the wire). */
  pty?: boolean | { rows: number; cols: number }
}

/** Options of the collecting `exec` helper. */
export interface CollectExecOptions extends ExecOptions {
  /** Full stdin payload, written once and closed before awaiting the exit. */
  stdin?: Uint8Array | string
  /** Kill the exec with SIGKILL after this many milliseconds; the result is
   * still returned, flagged `timedOut`. */
  timeoutMs?: number
  /** Bound on the combined collected stdout and stderr; exceeding it kills
   * the exec and rejects with {@link ExecOutputLimitError}. Default 16 MiB. */
  maxOutputBytes?: number
}

/** How one exec ended. */
export interface ExecExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Result of the collecting `exec` helper. */
export interface ExecResult extends ExecExit {
  stdout: Buffer
  stderr: Buffer
  /** True when the timeout fired and the exec was killed for it. */
  timedOut: boolean
}

/** Output listener signature of a streaming exec. */
export type ExecOutputListener = (stream: 'stdout' | 'stderr', chunk: Buffer) => void

/** Handle for one streaming exec. */
export interface ExecHandle {
  /** Id this exec was claimed under. */
  readonly id: number
  /** Guest-side process id. */
  readonly pid: number
  /**
   * Write one stdin chunk; chunks above the wire cap are split.
   * @param chunk - bytes or UTF-8 text to append to the child's stdin.
   */
  writeStdin(chunk: Uint8Array | string): void
  /** Close the child's stdin; it then reads EOF. */
  closeStdin(): void
  /**
   * Deliver a signal to the child.
   * @param sig - signal name; the guest maps the common POSIX set.
   */
  signal(sig: NodeJS.Signals): Promise<void>
  /** Resolves once with the exit state, or rejects when the world closes. */
  readonly exit: Promise<ExecExit>
  /**
   * Subscribe to output chunks.
   * @param listener - called per stdout/stderr chunk.
   * @returns the unsubscribe function.
   */
  onOutput(listener: ExecOutputListener): () => void
}

function validate(argv: string[], options: ExecOptions): void {
  if (argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) {
    throw new ExecOptionsError('argv must be a non-empty array of non-empty NUL-free strings')
  }
  if (options.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      if (key.length === 0 || key.includes('\0') || value.includes('\0')) {
        throw new ExecOptionsError('env entries must be non-empty keys with NUL-free values')
      }
    }
  }
  if (options.cwd !== undefined && (!options.cwd.startsWith('/') || options.cwd.includes('\0'))) {
    throw new ExecOptionsError('cwd must be an absolute path')
  }
  if (typeof options.pty === 'object'
    && (!Number.isInteger(options.pty.rows) || !Number.isInteger(options.pty.cols) || options.pty.rows < 1 || options.pty.cols < 1)) {
    throw new ExecOptionsError('pty rows and cols must be positive integers')
  }
}

function concat(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks)
}

/**
 * Exec operations bound to one world's control channel.
 */
export class ExecSession {
  constructor(
    private readonly transport: ControlTransport,
    private readonly allocateId: () => number,
  ) {}

  /**
   * Start one exec and return its streaming handle.
   * @param argv - guest command line; argv[0] resolves over the guest PATH.
   * @param options - env, cwd, and pty selection.
   * @throws ExecOptionsError on invalid host-side arguments.
   * @throws ExecStartError when the guest rejects the request.
   */
  async spawn(argv: string[], options: ExecOptions = {}): Promise<ExecHandle> {
    validate(argv, options)
    const id = this.allocateId()
    const pty = typeof options.pty === 'object' ? options.pty : (options.pty === true ? DEFAULT_PTY : undefined)
    const message: ExecMessage = { t: 'exec', id, argv }
    if (options.env !== undefined) message.env = options.env
    if (options.cwd !== undefined) message.cwd = options.cwd
    if (pty !== undefined) message.pty = pty
    const startPayload = await this.transport.request(
      message,
      payload => isOpReplyFor(payload, id, ['exec.started', 'exec.err']),
      OP_REPLY_TIMEOUT_MS,
    )
    const started = parseGuestMessage(startPayload)
    if (started === undefined || started.t !== 'exec.started') {
      if (started !== undefined && started.t === 'exec.err') throw new ExecStartError(id, started.message)
      throw new ExecStartError(id, 'unexpected start reply')
    }
    const pid = started.pid

    const listeners = new Set<ExecOutputListener>()
    let offEvent!: () => void
    let offClose!: () => void
    const exit = new Promise<ExecExit>((resolve, reject) => {
      offEvent = this.transport.onEvent(
        payload => isOpReplyFor(payload, id, ['exec.out', 'exec.exit']),
        (payload) => {
          const event = parseGuestMessage(payload)
          if (event?.t === 'exec.out') {
            const chunk = Buffer.from(event.d, 'base64')
            const stream = event.s === 'o' ? 'stdout' : 'stderr'
            for (const listener of listeners) listener(stream, chunk)
          }
          if (event?.t === 'exec.exit') {
            offEvent()
            offClose()
            resolve({ code: event.code, signal: (event.sig as NodeJS.Signals | undefined) ?? null })
          }
        },
      )
      offClose = this.transport.onClose((error) => {
        offEvent()
        reject(error)
      })
    })

    const sendStdin = (chunk: Uint8Array | string): void => {
      const bytes = Buffer.concat([typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : new Uint8Array(chunk)])
      for (let offset = 0; offset < bytes.length; offset += MAX_STDIN_CHUNK_BYTES) {
        const slice = bytes.subarray(offset, Math.min(offset + MAX_STDIN_CHUNK_BYTES, bytes.length))
        const message: HostMessage = { t: 'exec.stdin', id, d: slice.toString('base64') }
        this.transport.send(message)
      }
    }

    return {
      id,
      pid,
      writeStdin: sendStdin,
      closeStdin: () => {
        this.transport.send({ t: 'exec.stdin.close', id })
      },
      signal: async (sig: NodeJS.Signals) => {
        const payload = await this.transport.request(
          { t: 'exec.signal', id, sig },
          reply => isOpReplyFor(reply, id, ['exec.acked', 'exec.err']),
          OP_REPLY_TIMEOUT_MS,
        )
        const acked = parseGuestMessage(payload)
        if (acked !== undefined && acked.t === 'exec.err') throw new ExecStartError(id, acked.message)
      },
      exit,
      onOutput(listener: ExecOutputListener): () => void {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }

  /**
   * Run one exec to completion and collect its output.
   * @param argv - guest command line.
   * @param options - collection options including bounds and timeout.
   * @returns exit state plus collected stdout and stderr.
   * @throws ExecOutputLimitError when the bound is exceeded (exec killed).
   */
  async exec(argv: string[], options: CollectExecOptions = {}): Promise<ExecResult> {
    const limitBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const handle = await this.spawn(argv, options)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const flags = { limitHit: false, timedOut: false }
    const offOutput = handle.onOutput((stream, chunk) => {
      if (stream === 'stdout') {
        stdout.push(chunk)
        stdoutBytes += chunk.length
      } else {
        stderr.push(chunk)
        stderrBytes += chunk.length
      }
      if (stdoutBytes + stderrBytes > limitBytes) {
        flags.limitHit = true
        void handle.signal('SIGKILL').catch(() => {})
      }
    })
    if (options.stdin !== undefined) {
      handle.writeStdin(options.stdin)
      handle.closeStdin()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        flags.timedOut = true
        void handle.signal('SIGKILL').catch(() => {})
      }, options.timeoutMs)
    }
    try {
      const exit = await handle.exit
      if (flags.limitHit) throw new ExecOutputLimitError(limitBytes)
      return { ...exit, stdout: concat(stdout), stderr: concat(stderr), timedOut: flags.timedOut }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      offOutput()
    }
  }
}
