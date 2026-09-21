/** Managed process ranges and pull-based streams owned by one SSH helper. */
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { processIdSchema, spawnSchema } from './schemas.ts'
import { SSH_MAX_PROCESS_HANDLES } from './protocol.ts'

interface Record {
  handle: SubprocessHandle | SubprocessTerminalHandle
  terminal: boolean
  outcome: SubprocessOutcome | null
  failure?: Error
  cleanup?: Promise<void>
  reading: Set<string>
}

/** One helper owns all process handles, including ended roots with surviving descendants. */
export class RemoteProcesses {
  private readonly records = new Map<string, Record>()
  private readonly allocations = new Set<Promise<unknown>>()
  private closing = false

  constructor(private readonly ctx: Context) {}

  /**
   * Allocate one managed process or terminal under the capacity bound; aborted allocations roll back.
   * @param raw - wire spawn spec; validated against `spawnSchema`.
   * @param signal - aborts the allocation before or during spawn.
   * @returns the allocated handle id and pid.
   */
  async spawn(raw: unknown, signal: AbortSignal): Promise<{ id: string; pid: number }> {
    signal.throwIfAborted()
    if (this.closing || this.records.size + this.allocations.size >= SSH_MAX_PROCESS_HANDLES) throw new Error('SSH process capacity exhausted')
    const spec = spawnSchema.parse(raw)
    if (spec.stdio?.stdout === 'inherit' || spec.stdio?.stderr === 'inherit') throw new Error('SSH protocol streams cannot inherit helper stdio')
    const env = spec.env === undefined ? undefined
      : Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, value ?? undefined]))
    const allocation = (async () => {
      const handle = spec.terminal === undefined
        ? this.ctx.subprocess.spawn({ ...spec, env, stdio: spec.stdio as SubprocessSpawnSpec['stdio'],
          limits: spec.limits?.maxMemoryBytes === undefined ? undefined : { maxMemoryBytes: spec.limits.maxMemoryBytes }, signal })
        : await this.ctx.subprocess.spawnTerminal({ ...spec, ...spec.terminal,
          env: env === undefined ? undefined
            : Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          signal })
      const record: Record = { handle, terminal: spec.terminal !== undefined, outcome: null, reading: new Set() }
      const id = randomUUID()
      this.records.set(id, record)
      void handle.done.then((outcome) => { record.outcome = outcome }, (error: unknown) => {
        record.failure = error instanceof Error ? error : new Error(String(error))
      })
      if (this.closing || signal.aborted) {
        await this.terminate(record)
        this.records.delete(id)
        throw new Error('SSH process allocation cancelled')
      }
      return { id, pid: handle.pid }
    })()
    this.allocations.add(allocation)
    try { return await allocation } finally { this.allocations.delete(allocation) }
  }

  /**
   * Route one `process.*`/`terminal.*` method to its handle: lifecycle, reads, writes, and terminal control.
   * @param method - the remote operation name.
   * @param raw - id plus operation-specific arguments.
   * @param signal - aborts the underlying wait or read.
   * @returns the operation's validated reply value.
   */
  async dispatch(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const args = z.object({ id: processIdSchema, stream: z.enum(['stdout', 'stderr', 'terminal']).optional(),
      data: z.string().max(48 * 1024).nullable().optional(),
      signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']).optional(),
      cols: z.number().int().positive().max(65535).optional(), rows: z.number().int().positive().max(65535).optional(),
    }).strict().parse(raw)
    const record = this.records.get(args.id)
    if (record === undefined) throw new Error('Unknown SSH process handle')
    if (method === 'process.terminate' || method === 'process.release') {
      await this.terminate(record)
      if (method === 'process.release') this.records.delete(args.id)
      return null
    }
    if (record.failure !== undefined) throw record.failure
    if (method === 'process.state') {
      const collected: SubprocessCollectedOutputs = record.terminal ? {} : (record.handle as SubprocessHandle).collected
      return {
        outcome: record.outcome,
        collected: { stdout: collected.stdout?.readFrom(0), stderr: collected.stderr?.readFrom(0) },
      }
    }
    if (method === 'process.wait') {
      return record.terminal
        ? (await this.terminate(record), true)
        : await (record.handle as SubprocessHandle).waitForExit(signal)
    }
    if (method === 'process.read') {
      const streamName = args.stream
      if (streamName === undefined || record.reading.has(streamName)) throw new Error('SSH stream already has a reader')
      const stream = record.terminal && streamName === 'terminal'
        ? (record.handle as SubprocessTerminalHandle).output
        : !record.terminal && streamName !== 'terminal' ? (record.handle as SubprocessHandle)[streamName] : undefined
      if (stream === undefined) throw new Error('SSH process has no requested pipe')
      record.reading.add(streamName)
      try { return await readChunk(stream, signal) } finally { record.reading.delete(streamName) }
    }
    if (record.cleanup !== undefined) throw new Error('SSH process is closing')
    if (method === 'process.write') {
      const pipe = record.terminal ? undefined : (record.handle as SubprocessHandle).stdin
      if (pipe === undefined) throw new Error('SSH process has no stdin pipe')
      if (args.data === undefined) throw new Error('Missing stdin data')
      await writeChunk(pipe, args.data === null ? null : Buffer.from(args.data, 'base64'))
      return null
    }
    if (!record.terminal) throw new Error('SSH process is not a terminal')
    const terminal = record.handle as SubprocessTerminalHandle
    if (method === 'terminal.write') { await terminal.write(z.string().parse(args.data)); return null }
    if (method === 'terminal.inspect') return await terminal.inspectForeground() ?? null
    if (method === 'terminal.signal') return terminal.signalForeground(z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']).parse(args.signal))
    if (method === 'terminal.resize') { await terminal.resize(z.number().parse(args.cols), z.number().parse(args.rows)); return null }
    throw new Error(`Unsupported SSH process operation: ${method}`)
  }

  private terminate(record: Record): Promise<void> {
    record.cleanup ??= (async () => {
      await record.handle.terminate()
      if (!record.terminal) {
        await record.handle.done.catch(() => {})
        if (!await (record.handle as SubprocessHandle).waitForExit(AbortSignal.timeout(35_000))) throw new Error('SSH process range did not become quiescent')
      }
    })()
    return record.cleanup
  }

  /** Wait for in-flight allocations, terminate the full process range, and fail on unjoined survivors. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.allocations])
    const results = await Promise.allSettled([...this.records.values()].map(record => this.terminate(record)))
    this.records.clear()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (errors.length > 0) throw new AggregateError(errors, 'SSH process cleanup failed')
  }
}

/** Return at most 32 KiB, preserving pipe backpressure while the caller is idle. */
async function readChunk(stream: Readable, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  while (true) {
    const chunk = stream.read(Math.min(32 * 1024, stream.readableLength || 1)) as Buffer | null
    if (chunk !== null) return chunk.toString('base64')
    if (stream.readableEnded || stream.destroyed) return null
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stream.off('readable', ready); stream.off('end', ready); stream.off('close', ready); stream.off('error', failed)
        signal.removeEventListener('abort', aborted)
      }
      const ready = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const aborted = (): void => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      }
      stream.once('readable', ready); stream.once('end', ready); stream.once('close', ready); stream.once('error', failed)
      signal.addEventListener('abort', aborted, { once: true })
      /* v8 ignore next -- reaching the synchronous check already aborted requires landing between listener registration and this line */
      if (signal.aborted) aborted()
    })
  }
}

async function writeChunk(stream: Writable, data: Buffer | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const callback = (error?: Error | null): void => { if (error) reject(error); else resolve() }
    if (data === null) stream.end(callback)
    else stream.write(data, callback)
  })
}
