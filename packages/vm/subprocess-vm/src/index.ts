/**
 * Subprocess provider for one execution world (`ctx.vm`): children and
 * terminals live inside the world, never on the host. Maps the
 * `SubprocessRuntime` contract onto the world seam's exec surface — streamed
 * output, stdin pipes, POSIX signals, pty terminals — and terminates
 * everything it started when the service disposes.
 *
 * World-shaped semantics that differ from the local provider are recorded in
 * this package's README (Known Limitations): no host environment inherits
 * into the world, collected output keeps no spill file, and termination
 * signals the child the world agent tracks, not a host process group.
 * @module @deepseek-ai/dsh-subprocess-vm
 */

import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ExecHandle, ExecOptions, VmWorld } from '@deepseek-ai/dsh-vm'

const POSIX_QUOTE_ESCAPE = '\'\\\'\''

/** One shell-single-quoted POSIX word; `command -v` arguments travel safely. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", POSIX_QUOTE_ESCAPE)}'`
}

/** Drop tombstoned entries; explicit world env carries only defined values. */
function worldEnv(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value
  }
  return defined
}

/** In-memory tail window of one collected stream with byte-offset reads. */
class TailBuffer {
  private chunks: Buffer[] = []
  private start = 0
  private total = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.total += chunk.length
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped === undefined) break
      this.start += dropped.length
      this.total -= dropped.length
    }
    if (this.total > this.maxBytes && this.chunks[0] !== undefined) {
      const drop = this.total - this.maxBytes
      this.chunks[0] = this.chunks[0].subarray(drop)
      this.start += drop
      this.total = this.maxBytes
    }
  }

  /** Bytes at the tail that do not yet form a complete UTF-8 sequence. */
  private incompleteTailBytes(window: Buffer): number {
    for (let i = window.length - 1; i >= 0 && i >= window.length - 4; i -= 1) {
      const byte = window[i]
      if (byte === undefined || (byte & 0x80) === 0) return 0
      if ((byte & 0xC0) === 0xC0) {
        const need = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : 2
        return i + need > window.length ? window.length - i : 0
      }
    }
    return 0
  }

  readFrom(offset: number): SubprocessOutputRead {
    const window = Buffer.concat(this.chunks)
    const complete = window.subarray(0, window.length - this.incompleteTailBytes(window))
    const lossy = offset < this.start
    const begin = Math.max(0, Math.min(offset - this.start, complete.length))
    return {
      text: complete.subarray(begin).toString('utf8'),
      nextOffset: this.start + complete.length,
      lossy,
    }
  }
}

/** An empty pre-settlement read snapshot. */
function emptyRead(): SubprocessOutputRead {
  return { text: '', nextOffset: 0, lossy: false }
}

/** Every ordinary child and terminal belongs to this provider's disposal boundary. */
export class VmSubprocessRuntime extends SubprocessRuntime {
  static inject = ['vm']
  private readonly cleanups = new Set<() => Promise<void>>()
  private readonly lifetime = new AbortController()

  /** Children and executables live inside the world, never on this host. */
  override get locality(): 'local' | 'remote' {
    return 'remote'
  }

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('vm subprocess provider disposed'))
      await Promise.allSettled([...this.cleanups].map(cleanup => cleanup()))
    })
  }

  private get world(): VmWorld {
    return this.ctx.vm
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const options: ExecOptions = {}
    const exported = worldEnv(env)
    if (exported !== undefined) options.env = exported
    if (command.includes('/')) {
      if (!command.startsWith('/')) {
        throw new Error(`subprocess-vm: refusing a relative executable path with separators: ${command}`)
      }
      const check = await this.world.exec(['sh', '-c', `test -x ${posixQuote(command)} && echo ok`], options)
      if (check.code !== 0) throw new Error(`subprocess-vm: not an executable inside the world: ${command}`)
      return command
    }
    const found = await this.world.exec(['sh', '-c', `command -v ${posixQuote(command)}`], options)
    if (found.code !== 0) throw new Error(`subprocess-vm: no such executable in the world's PATH: ${command}`)
    const path = found.stdout.toString('utf8').trim()
    if (path === '') throw new Error(`subprocess-vm: the world's PATH resolved ${command} to nothing`)
    return path
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.lifetime.signal.throwIfAborted()
    let pid = -1
    let termination: Promise<void> | undefined
    const env = worldEnv(spec.env)
    const started = this.world.spawn([...spec.argv], {
      cwd: spec.cwd,
      ...(env === undefined ? {} : { env }),
    })
    const settle = started.then((handle) => {
      pid = handle.pid
      return handle
    })
    const done = (async (): Promise<SubprocessOutcome> => {
      const handle = await settle
      const exit = await handle.exit
      return { exitCode: exit.code, signal: exit.signal }
    })()
    void done.catch(() => {})

    const pipes = new Map<'stdout' | 'stderr', Readable>()
    const collected = new Map<'stdout' | 'stderr', TailBuffer>()
    for (const stream of ['stdout', 'stderr'] as const) {
      const mode = spec.stdio[stream]
      if (mode === 'pipe' || mode === 'inherit') {
        const pipe = new Readable({ read() {} })
        if (mode === 'inherit') pipe.pipe(stream === 'stdout' ? process.stdout : process.stderr, { end: false })
        pipes.set(stream, pipe)
      } else {
        collected.set(stream, new TailBuffer(mode.maxBytes))
      }
    }
    void settle.then((handle) => {
      handle.onOutput((stream, chunk) => {
        const pipe = pipes.get(stream)
        if (pipe !== undefined) {
          pipe.push(chunk)
          return
        }
        collected.get(stream)?.append(chunk)
      })
      void handle.exit.then(() => {
        for (const pipe of pipes.values()) pipe.push(null)
      }, (error: unknown) => {
        for (const pipe of pipes.values()) pipe.destroy(error instanceof Error ? error : new Error(String(error)))
      })
    }, (error: unknown) => {
      startError = error instanceof Error ? error : new Error(String(error))
      queuedStdin.length = 0
      for (const pipe of pipes.values()) pipe.destroy(startError)
    })

    const queuedStdin: Buffer[] = []
    let stdinHandle: ExecHandle | undefined
    let stdinClosed = false
    let startError: Error | undefined
    const flushStdin = (): (void) => {
      const handle = stdinHandle
      if (handle === undefined) return
      for (const chunk of queuedStdin.splice(0)) {
        handle.writeStdin(chunk)
      }
      if (stdinClosed) handle.closeStdin()
    }
    if (spec.stdio.stdin !== 'ignore') {
      if (typeof spec.stdio.stdin === 'object') {
        queuedStdin.push(Buffer.from(spec.stdio.stdin.data, 'utf8'))
        stdinClosed = true
      }
      void settle.then((handle) => {
        stdinHandle = handle
        flushStdin()
      }).catch(() => {})
    }

    let exited = false
    void done.then(() => { exited = true }, () => { exited = true })
    const terminate = (): (void) => {
      termination ??= (async () => {
        if (exited) return
        const handle = await settle
        await handle.signal('SIGTERM').catch(() => {})
        const kill = setTimeout(() => {
          void handle.signal('SIGKILL').catch(() => {})
        }, spec.graceMs)
        void handle.exit.finally(() => {
          clearTimeout(kill)
        }).catch(() => {})
      })().catch(() => {})
    }
    const signal = spec.signal === undefined ? this.lifetime.signal : AbortSignal.any([spec.signal, this.lifetime.signal])
    const aborted = (): (void) => {
      terminate()
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
    }
    void done.finally(() => {
      signal.removeEventListener('abort', aborted)
    }).catch(() => {})

    const cleanup = async (): Promise<void> => {
      terminate()
      await done.catch(() => {})
      this.cleanups.delete(cleanup)
    }
    this.cleanups.add(cleanup)

    const stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (startError !== undefined) {
            callback(startError)
            return
          }
          queuedStdin.push(chunk)
          flushStdin()
          callback()
        },
        final(callback) {
          if (startError !== undefined) {
            callback(startError)
            return
          }
          stdinClosed = true
          flushStdin()
          callback()
        },
      })
      : undefined

    const reader = (stream: 'stdout' | 'stderr'): { readFrom: (offset: number) => SubprocessOutputRead } => {
      const tail = collected.get(stream)
      return { readFrom: (offset: number) => (tail === undefined ? emptyRead() : tail.readFrom(offset)) }
    }

    return {
      get pid() { return pid },
      stdin,
      stdout: pipes.get('stdout'),
      stderr: pipes.get('stderr'),
      collected: {
        ...(typeof spec.stdio.stdout === 'object' ? { stdout: reader('stdout') } : {}),
        ...(typeof spec.stdio.stderr === 'object' ? { stderr: reader('stderr') } : {}),
      } satisfies SubprocessCollectedOutputs,
      done,
      terminate,
      waitForExit: async (bound) => {
        if (bound?.aborted) return false
        if (bound === undefined) {
          await done.catch(() => {})
          return true
        }
        /* v8 ignore next -- the executor below reassigns abort synchronously before any invocation */
        let abort = (): (void) => {}
        const cancelled = new Promise<false>((resolve) => {
          abort = () => { resolve(false) }
          bound.addEventListener('abort', abort, { once: true })
        })
        try {
          return await Promise.race([done.catch(() => {}).then(() => true), cancelled])
        } finally {
          bound.removeEventListener('abort', abort)
        }
      },
    }
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.lifetime.signal.throwIfAborted()
    spec.signal?.throwIfAborted()
    const env = worldEnv(spec.env) ?? {}
    env.TERM = spec.term ?? 'dumb'
    const handle = await this.world.spawn([...spec.argv], {
      cwd: spec.cwd,
      env,
      pty: { rows: spec.rows, cols: spec.cols },
    })
    let termination: Promise<void> | undefined
    const output = new Readable({ read() {} })
    const unsubscribe = handle.onOutput((_stream, chunk) => { output.push(chunk) })
    const done = (async (): Promise<SubprocessOutcome> => {
      const exit = await handle.exit
      return { exitCode: exit.code, signal: exit.signal }
    })()
    void done.catch(() => {})
    void handle.exit.then(() => { output.push(null) }, () => { output.destroy() })
    const terminate = (): Promise<void> => {
      termination ??= (async () => {
        await handle.signal('SIGTERM').catch(() => {})
        const kill = setTimeout(() => {
          void handle.signal('SIGKILL').catch(() => {})
        }, spec.graceMs)
        await handle.exit.finally(() => {
          clearTimeout(kill)
        }).catch(() => {})
        unsubscribe()
      })()
      return termination
    }
    const signal = spec.signal === undefined ? this.lifetime.signal : AbortSignal.any([spec.signal, this.lifetime.signal])
    const aborted = (): (void) => {
      void terminate()
    }
    signal.addEventListener('abort', aborted, { once: true })
    /* v8 ignore next -- a pre-aborted allocation signal throws at entry; only the listener path can fire here. */
    if (signal.aborted) {
      aborted()
    }
    void done.finally(() => {
      signal.removeEventListener('abort', aborted)
    }).catch(() => {})
    const cleanup = async (): Promise<void> => {
      await terminate()
      this.cleanups.delete(cleanup)
    }
    this.cleanups.add(cleanup)
    return {
      pid: handle.pid,
      output,
      done,
      // oxlint-disable-next-line typescript/require-await -- async converts a closed world's sync throw into the contract's rejection.
      write: async (data) => {
        handle.writeStdin(data)
      },
      // oxlint-disable-next-line typescript/require-await -- the refusal is the whole operation.
      resize: async () => {
        throw new Error('subprocess-vm: the v0 world agent has no pty resize operation')
      },
      inspectForeground: () => Promise.resolve(undefined),
      signalForeground: () => Promise.reject(new Error('subprocess-vm: the v0 world agent exposes no terminal foreground group')),
      terminate: async () => {
        await terminate()
      },
    }
  }
}

export default VmSubprocessRuntime
