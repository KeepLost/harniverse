/** Scripted stand-in for the Harniverse client: records calls, answers with defaults, and lets a test push mux frames. */

import type { CallOptions, MuxDelivery, MuxFrame, MuxOptions, RespondReceipt, RespondResult } from '@deepseek-ai/dsh-chat-harniverse-client'
import type { BridgeClient } from '../../src/ports.ts'

/** One recorded unary or Typert call. */
export interface Call {
  method: string
  payload: Record<string, unknown>
  options: CallOptions
}

/** A controllable mux. */
export class FakeMux {
  closed = false
  private opened!: () => void
  private failed!: (error: Error) => void
  private readonly open = new Promise<void>((resolve, reject) => { this.opened = resolve; this.failed = reject })

  constructor(readonly options: MuxOptions) {}

  whenOpen(): Promise<void> {
    return this.open
  }

  /** Reject `whenOpen`, as a mux closed before it opened does. */
  markClosed(): void {
    this.failed(new Error('mux closed'))
  }

  /** Resolve `whenOpen`. */
  markOpen(): void {
    this.opened()
  }

  close(): void {
    this.closed = true
  }

  /** Deliver one frame through the bridge's handler. */
  async push(frame: MuxFrame, rpcId = `rpc-${String(Math.random())}`): Promise<void> {
    const delivery: MuxDelivery = { rpcId, frame, ...this.options.remoteHost === undefined ? {} : { remoteHost: this.options.remoteHost } }
    await this.options.onFrame(delivery)
    if (frame.type === 'session/event') this.options.onCursor?.(frame.sessionId, frame.event.seq)
  }

  /** Deliver one durable session event. */
  async event(sessionId: string, seq: number, type: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.push({ type: 'session/event', sessionId, event: { type, seq, time: 1, data } })
  }
}

type Handler = (payload: Record<string, unknown>, options: CallOptions) => unknown

/** The scripted client. */
export class FakeClient {
  readonly calls: Call[] = []
  readonly responds: Array<{ rpcId: string; result: RespondResult; options: CallOptions }> = []
  readonly uploads: Array<{ bytes: Uint8Array; meta: { name?: string; mediaType?: string }; options: CallOptions }> = []
  readonly muxes: FakeMux[] = []
  receipt: RespondReceipt | Error = { accepted: true }
  private readonly handlers = new Map<string, Handler>()
  private counter = 0
  bootId = 'boot-1'

  /** Replace the answer of one method. */
  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  /** @returns calls of one method. */
  of(method: string): Call[] {
    return this.calls.filter(call => call.method === method)
  }

  /** @returns the mux bound to a remote host (or the local one). */
  mux(remoteHost?: string): FakeMux {
    const found = this.muxes.find(candidate => candidate.options.remoteHost === remoteHost)
    if (found === undefined) throw new Error(`no mux for ${String(remoteHost)}`)
    return found
  }

  private answer(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case 'session.create': return { sessionId: payload.sessionId }
      case 'session.prompt': return { accepted: true, messageId: `inbox-${String(++this.counter)}`, operationId: `op-${String(this.counter)}` }
      case 'session.cancel': return { accepted: true }
      case 'session.rename': return { title: payload.title, seq: 1 }
      case 'session.workStatus': return { messageId: payload.messageId, status: { state: 'queued' } }
      case 'session.updateQueue': return { accepted: true, messageId: payload.itemId, status: { state: 'discarded' } }
      case 'session.models': return { current: { provider: 'p', model: 'm1' }, groups: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }] }
      case 'session.selectModel': return { selected: { provider: payload.provider, model: payload.model } }
      case 'session.history': return { events: [], hasMore: false }
      case 'commands/execute': return { commandId: 'c1', result: { kind: 'success', text: 'Compacted.' } }
      default: throw new Error(`FakeClient: no default answer for ${method}`)
    }
  }

  call = (method: string, payload: unknown, options: CallOptions = {}): Promise<never> => {
    const body = payload as Record<string, unknown>
    this.calls.push({ method, payload: body, options })
    try {
      const handler = this.handlers.get(method)
      return Promise.resolve((handler === undefined ? this.answer(method, body) : handler(body, options)) as never)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  typert = (endpoint: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<unknown> => {
    return this.call(endpoint, args, options)
  }

  describeHost = (options: CallOptions = {}): Promise<{ bootId: string }> => {
    this.calls.push({ method: 'host.describe', payload: {}, options })
    return Promise.resolve({ bootId: this.bootId })
  }

  respond = (rpcId: string, result: RespondResult, options: CallOptions = {}): Promise<RespondReceipt> => {
    this.responds.push({ rpcId, result, options })
    return this.receipt instanceof Error ? Promise.reject(this.receipt) : Promise.resolve(this.receipt)
  }

  upload = (
    bytes: Uint8Array,
    meta: { name?: string; mediaType?: string },
    options: CallOptions = {},
  ): Promise<{ attachmentId: string; bytes: number }> => {
    this.uploads.push({ bytes, meta, options })
    return Promise.resolve({ attachmentId: `att-${String(this.uploads.length)}`, bytes: bytes.byteLength })
  }

  openMux = (options: MuxOptions): FakeMux => {
    const mux = new FakeMux(options)
    this.muxes.push(mux)
    return mux
  }

  /** The object the bridge consumes. */
  asClient(): BridgeClient {
    return this as unknown as BridgeClient
  }
}
