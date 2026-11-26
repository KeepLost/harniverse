/**
 * JSON-RPC 2.0 over one ACP stream. The SDK's client app validates every
 * `session/update` against its own schema and drops a variant it does not
 * know, so the client core speaks JSON-RPC itself: framing comes from the SDK,
 * and every incoming message is read with the forward-compatible parsers of
 * this package.
 * @module @deepseek-ai/dsh-acp-client/rpc
 */

import { ndJsonStream, type AnyMessage } from '@agentclientprotocol/sdk'
import { AcpError, acpErrorKindForCode } from './errors.ts'
import type { AcpIo } from './transport.ts'
import { isRecord, type RawRecord } from './update.ts'

/** JSON-RPC `Method not found`. */
export const METHOD_NOT_FOUND = -32601

/** What a peer does with the messages the other side initiates. */
export interface PeerHandlers {
  /** A notification. The peer never answers it. */
  notification(method: string, params: unknown): void
  /**
   * A request. The resolved value becomes its result; a rejection carrying an
   * `AcpError` code becomes that error and anything else an internal error.
   */
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One end of a JSON-RPC connection: request correlation, notification dispatch, and closure. */
export class JsonRpcPeer {
  private nextId = 0
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>()
  private readonly incoming = new Map<string | number, AbortController>()
  private readonly writer: WritableStreamDefaultWriter<AnyMessage>
  private readonly reader: ReadableStreamDefaultReader<AnyMessage>
  private readonly done = Promise.withResolvers<void>()
  private broken: AcpError | undefined
  /** Settles when either side closed or failed the stream, after every pending request rejected. */
  readonly closed: Promise<void> = this.done.promise

  constructor(io: AcpIo, private readonly handlers: PeerHandlers) {
    const stream = ndJsonStream(io.output, io.input)
    this.writer = stream.writable.getWriter()
    this.reader = stream.readable.getReader()
    // The output side dying takes the agent's input with it. A write already
    // in flight may still settle, so the stream's own failure is what breaks
    // the connection.
    void this.writer.closed.then(undefined, (error: unknown) => {
      this.break(new AcpError('transport', `the agent connection failed: ${describe(error)}`, { cause: error }))
    })
    void this.read()
  }

  private async read(): Promise<void> {
    let failure: AcpError | undefined
    try {
      while (true) {
        const next = await this.reader.read()
        if (next.done) break
        this.receive(next.value)
      }
    } catch (error: unknown) {
      failure = new AcpError('transport', `the agent connection failed: ${describe(error)}`, { cause: error })
    }
    this.break(failure ?? new AcpError('transport', 'the agent closed the connection'))
  }

  /** End the connection from this side; the read loop then rejects what is pending. */
  close(): void {
    void this.writer.close().catch(() => {
      // A stream that already failed cannot close again; the read loop reports it.
    })
    void this.reader.cancel().catch(() => {
      // Cancelling a reader that already ended is refused; nothing is left to read.
    })
  }

  private break(error: AcpError): void {
    this.broken = error
    // Closure is published first so a rejection handler can tell a lost
    // connection from an agent error by the time it runs.
    this.done.resolve()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort(error)
    this.incoming.clear()
  }

  private receive(message: AnyMessage): void {
    // The framing layer admits JSON-RPC envelopes only; every field is read
    // here as unknown and validated one by one.
    const raw = message as unknown as RawRecord
    if (typeof raw.method === 'string') {
      if (raw.method === '$/cancel_request') {
        const id = isRecord(raw.params) ? raw.params.id : undefined
        if (typeof id === 'string' || typeof id === 'number') this.incoming.get(id)?.abort()
        return
      }
      if (raw.id === undefined) {
        this.handlers.notification(raw.method, raw.params)
        return
      }
      switch (typeof raw.id) {
        case 'string':
        case 'number':
          void this.serve(raw.id, raw.method, raw.params)
          return
        // JSON-RPC permits a null id; such a request has no identity to answer.
        default:
          return
      }
    }
    if (typeof raw.id !== 'number') return
    const pending = this.pending.get(raw.id)
    if (pending === undefined) return
    this.pending.delete(raw.id)
    const error = raw.error
    if (isRecord(error)) {
      const code = typeof error.code === 'number' ? error.code : undefined
      pending.reject(new AcpError(acpErrorKindForCode(code, 'protocol'), typeof error.message === 'string' ? error.message : 'the agent answered with an error', {
        ...code === undefined ? {} : { code },
      }))
    } else {
      pending.resolve(raw.result)
    }
  }

  private async serve(id: string | number, method: string, params: unknown): Promise<void> {
    const controller = new AbortController()
    this.incoming.set(id, controller)
    try {
      const result = await this.handlers.request(method, params, controller.signal)
      await this.writer.write({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (error: unknown) {
      const code = error instanceof AcpError && error.code !== undefined ? error.code : -32603
      await this.writer.write({ jsonrpc: '2.0', id, error: { code, message: describe(error) } }).catch(() => {
        // The agent is gone; an answer nobody reads needs no report.
      })
    } finally {
      this.incoming.delete(id)
    }
  }

  /**
   * Write one message. A failed write means the agent's input is gone, so it
   * breaks the connection: every pending request rejects with the transport
   * failure, this write included.
   */
  private write(message: AnyMessage): Promise<void> {
    if (this.broken !== undefined) return Promise.reject(this.broken)
    return this.writer.write(message).catch((error: unknown) => {
      const failure = new AcpError('transport', `the agent connection failed: ${describe(error)}`, { cause: error })
      this.break(failure)
      throw failure
    })
  }

  /**
   * Send a request and await its response.
   * @param method - the agent-side method.
   * @param params - the request params.
   * @returns the response result.
   * @throws an `AcpError` when the agent answered an error or the connection broke.
   */
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.broken !== undefined) return Promise.reject(this.broken)
    const id = ++this.nextId
    const pending = Promise.withResolvers<unknown>()
    // A caller that moved on must not surface this rejection as unhandled.
    void pending.promise.catch(() => {})
    this.pending.set(id, pending)
    void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {
      // break() already rejected this request with the transport failure.
    })
    return pending.promise as Promise<T>
  }

  /**
   * Send a notification; resolves once it was written.
   * @param method - the agent-side notification method.
   * @param params - the notification params.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }
}
