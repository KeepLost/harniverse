/** Subprocess provider for one SSH execution world, with bounded pull streams. */
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import { foregroundSchema, processStateSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

const allocationSchema = z.object({ id: z.uuid(), pid: z.number().int() }).strict()
const empty = (): SubprocessOutputRead => ({ text: '', nextOffset: 0, lossy: false })

/** Every ordinary child and terminal belongs to this provider's disposal boundary. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']
  private readonly cleanups = new Set<() => Promise<void>>()
  private readonly allocations = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('SSH subprocess provider disposed'))
      await Promise.allSettled([...this.allocations])
      await Promise.allSettled([...this.cleanups].map(cleanup => cleanup()))
    })
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.ctx.ssh.request('executable', { command, env }, z.string(), signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.lifetime.signal.throwIfAborted()
    const ssh = this.ctx.ssh
    const ready = ssh.request('process.spawn', wireSpec(spec), allocationSchema)
    this.allocations.add(ready)
    void ready.finally(() => { this.allocations.delete(ready) }).catch(() => {})
    let pid = -1
    let termination: Promise<void> | undefined
    let release: Promise<void> | undefined
    let stdout = empty()
    let stderr = empty()
    const streamSignal = AbortSignal.any([ssh.signal, this.lifetime.signal])
    const request = async <T>(method: string, fields: object, schema: z.ZodType<T>, wait = false): Promise<T> => {
      const { id } = await ready
      return ssh.request(method, { id, ...fields }, schema, undefined, wait)
    }
    const terminate = (): Promise<void> => {
      termination ??= request('process.terminate', {}, z.null()).then(() => {})
      void termination.catch(() => {})
      return termination
    }
    const cleanup = (): Promise<void> => {
      release ??= (async () => {
        await terminate()
        await request('process.release', {}, z.null())
      })()
      return release
    }
    this.cleanups.add(cleanup)
    const pipeOutputs = {
      stdout: typeof spec.stdio.stdout === 'string' ? pullStream(ssh, ready, 'stdout', streamSignal) : undefined,
      stderr: typeof spec.stdio.stderr === 'string' ? pullStream(ssh, ready, 'stderr', streamSignal) : undefined,
    }
    if (spec.stdio.stdout === 'inherit') pipeOutputs.stdout?.pipe(process.stdout, { end: false })
    if (spec.stdio.stderr === 'inherit') pipeOutputs.stderr?.pipe(process.stderr, { end: false })
    const pipesEnded = Object.values(pipeOutputs).filter((stream): stream is Readable => stream !== undefined)
      .map(stream => new Promise<void>((resolve) => { stream.once('end', resolve); stream.once('close', resolve); stream.once('error', resolve) }))
    const signal = spec.signal === undefined ? this.lifetime.signal : AbortSignal.any([spec.signal, this.lifetime.signal])
    const aborted = (): void => { void terminate().catch(() => {}) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        pid = (await ready).pid
        while (true) {
          const state = await request('process.state', {}, processStateSchema)
          stdout = (state.collected.stdout ?? empty()) as SubprocessOutputRead
          stderr = (state.collected.stderr ?? empty()) as SubprocessOutputRead
          if (state.outcome !== null) return state.outcome as SubprocessOutcome
          await delay(20, undefined, { signal: streamSignal })
        }
      } finally { signal.removeEventListener('abort', aborted) }
    })()
    void done.catch(() => {})
    const treeExited = done.then(() => request('process.wait', {}, z.boolean(), true))
    void treeExited.catch(() => {})
    const quiescent = (async () => {
      try {
        await treeExited
        await Promise.all(pipesEnded)
        await cleanup()
      } finally { this.cleanups.delete(cleanup) }
    })()
    void quiescent.catch(() => {})
    const readFrom = (snapshot: SubprocessOutputRead, offset: number): SubprocessOutputRead => {
      const bytes = Buffer.from(snapshot.text)
      const first = snapshot.nextOffset - bytes.length
      return { ...snapshot, text: bytes.subarray(Math.max(0, offset - first)).toString('utf8'), lossy: offset < first }
    }
    return {
      get pid() { return pid },
      stdin: spec.stdio.stdin === 'pipe' ? new Writable({
        write(chunk: Buffer, _encoding, callback) {
          void (async () => {
            for (let offset = 0; offset < chunk.length; offset += 24 * 1024) {
              await request('process.write', { data: chunk.subarray(offset, offset + 24 * 1024).toString('base64') }, z.null())
            }
          })().then(() => { callback() }, (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)))
          })
        },
        final(callback) {
          void request('process.write', { data: null }, z.null()).then(() => { callback() }, (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)))
          })
        },
      }) : undefined,
      stdout: spec.stdio.stdout === 'pipe' ? pipeOutputs.stdout : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? pipeOutputs.stderr : undefined,
      collected: {
        ...(typeof spec.stdio.stdout === 'object' ? { stdout: { readFrom: (offset: number) => readFrom(stdout, offset) } } : {}),
        ...(typeof spec.stdio.stderr === 'object' ? { stderr: { readFrom: (offset: number) => readFrom(stderr, offset) } } : {}),
      },
      done,
      terminate: () => { void terminate().catch(() => {}) },
      waitForExit: async (bound) => {
        if (bound?.aborted) return false
        if (bound === undefined) return treeExited
        /* v8 ignore next -- the executor below reassigns abort synchronously before any invocation */
        let abort = (): void => {}
        const cancelled = new Promise<false>((resolve) => { abort = () => { resolve(false) }; bound.addEventListener('abort', abort, { once: true }) })
        try { return await Promise.race([treeExited, cancelled]) }
        finally { bound.removeEventListener('abort', abort) }
      },
    }
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.lifetime.signal.throwIfAborted()
    spec.signal?.throwIfAborted()
    const ssh = this.ctx.ssh
    const ready = ssh.request('process.spawn', { argv: spec.argv, cwd: spec.cwd, env: spec.env, graceMs: spec.graceMs,
      terminal: { rows: spec.rows, cols: spec.cols } }, allocationSchema)
    this.allocations.add(ready)
    let allocation: z.infer<typeof allocationSchema>
    try { allocation = await ready } finally { this.allocations.delete(ready) }
    const { id, pid } = allocation
    let cleanupPromise: Promise<void> | undefined
    const operations = new Set<Promise<unknown>>()
    const controller = new AbortController()
    const signal = AbortSignal.any([ssh.signal, controller.signal])
    const operation = <T>(method: string, fields: object, schema: z.ZodType<T>): Promise<T> => {
      if (cleanupPromise !== undefined) return Promise.reject(new Error('SSH terminal is closing'))
      const promise = ssh.request(method, { id, ...fields }, schema)
      operations.add(promise)
      void promise.finally(() => { operations.delete(promise) }).catch(() => {})
      return promise
    }
    const output = pullStream(ssh, Promise.resolve(allocation), 'terminal', signal)
    const done = (async (): Promise<SubprocessOutcome> => {
      while (true) {
        const state = await ssh.request('process.state', { id }, processStateSchema)
        if (state.outcome !== null) return state.outcome as SubprocessOutcome
        await delay(20, undefined, { signal })
      }
    })()
    void done.catch(() => {})
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        await ssh.request('process.terminate', { id }, z.null())
        await Promise.allSettled([...operations])
        await done
        output.destroy()
        controller.abort()
        await ssh.request('process.release', { id }, z.null())
        this.cleanups.delete(cleanup)
      })()
      return cleanupPromise
    }
    this.cleanups.add(cleanup)
    if (this.lifetime.signal.aborted || spec.signal?.aborted) { await cleanup(); throw new Error('SSH terminal allocation cancelled') }
    return {
      pid, output, done,
      write: data => operation('terminal.write', { data }, z.null()).then(() => {}),
      resize: (cols, rows) => operation('terminal.resize', { cols, rows }, z.null()).then(() => {}),
      inspectForeground: () => operation('terminal.inspect', {}, foregroundSchema).then(value => value ?? undefined),
      signalForeground: value => operation('terminal.signal', { signal: value }, z.number()),
      terminate: cleanup,
    }
  }
}

function wireSpec(spec: SubprocessSpawnSpec): object {
  const stdio = {
    ...spec.stdio,
    stdout: spec.stdio.stdout === 'inherit' ? 'pipe' : spec.stdio.stdout,
    stderr: spec.stdio.stderr === 'inherit' ? 'pipe' : spec.stdio.stderr,
  }
  return {
    argv: spec.argv, cwd: spec.cwd, stdio, graceMs: spec.graceMs, limits: spec.limits,
    env: spec.env === undefined ? undefined
      : Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, value ?? null])),
  }
}

function pullStream(ssh: SshConnection, allocation: Promise<{ id: string }>, stream: string, signal: AbortSignal): Readable {
  return Readable.from((async function* () {
    const { id } = await allocation
    while (!signal.aborted) {
      const data = await ssh.request('process.read', { id, stream }, z.string().nullable(), undefined, true)
      if (data === null) return
      yield Buffer.from(data, 'base64')
    }
  })(), { objectMode: false, highWaterMark: 32 * 1024 })
}
export default SshSubprocessRuntime
