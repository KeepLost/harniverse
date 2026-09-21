/** Bounded RPC over the shared control channel. SSH authenticates both streams. */
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { ControlChannelTransport, DEFAULT_CONTROL_CHANNEL_LIMITS } from '@deepseek-ai/dsh-control-channel'
import { z } from 'zod'

export const SSH_PROTOCOL_VERSION = 1
export const SSH_MAX_PROCESS_HANDLES = 32
export const SSH_MAX_TEXT_STREAMS = 64

/** A remote operation preserves the owning filesystem/sandbox error code. */
export class RemoteOperationError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'RemoteOperationError'
  }
}

const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), message: z.string(), code: z.string().optional() }).strict(),
])

/** One non-reconnecting peer; cancellation closes the world rather than replaying mutations. */
export class SshRpcPeer extends EventEmitter {
  private readonly transport: ControlChannelTransport
  private readonly lifetime = new AbortController()
  private failure: Error | undefined
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    maxFrameBytes: number = 1024 * 1024,
    maxPending: number = 128,
    handler?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    super()
    this.transport = new ControlChannelTransport({
      input, output,
      limits: { ...DEFAULT_CONTROL_CHANNEL_LIMITS, maxFrameBytes, maxPendingCalls: maxPending, maxQueuedBytes: maxFrameBytes * 2 },
      handlers: {
        onCall: async (frame) => {
          if (handler === undefined) throw new Error('SSH client does not serve calls')
          if (this.operations.size >= maxPending) throw new Error('SSH active request limit exceeded')
          const operation = handler(frame.target, frame.args[0], this.lifetime.signal)
          this.operations.add(operation)
          try { return { ok: true, value: (await operation) ?? null } }
          catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error),
              ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) }
          } finally { this.operations.delete(operation) }
        },
      },
    })
    void this.transport.outcome().then((outcome) => {
      this.close(new Error(outcome.kind === 'failure' ? outcome.failure.message : 'SSH helper ended'))
    })
    input.once('close', () => { this.close() })
    output.once('close', () => { this.close() })
  }

  /** Validate each reply before handing it to a provider. Cancellation invalidates this connection. */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    const abort = (): void => { this.close(new Error('SSH operation cancelled; completed mutations are not rolled back')) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const reply = response.parse(await this.transport.call(method, [params]))
      if (!reply.ok) throw new RemoteOperationError(reply.message, reply.code)
      return schema.parse(reply.value)
    } finally { signal?.removeEventListener('abort', abort) }
  }

  /** Record the first transport failure and revoke every in-flight handler. */
  close(error = new Error('SSH disconnected; remote outcome is unknown')): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    this.transport.cancel(error.message)
    this.input.destroy()
    this.output.destroy()
    this.emit('closed', error)
  }

  /** Join active handlers before disposing the shared control transport. */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.close()
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      await this.transport.dispose()
    })()
    return this.disposal
  }
}
