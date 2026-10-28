/**
 * Browser-side entity-stream downlink: one lazily-opened, page-scoped
 * WebSocket carrying every per-entity stream family (terminal follow,
 * terminal hold, browser follow, workspace file watch) as addressable
 * substreams, so the page's long-lived connection count stays constant no
 * matter how many directories, terminals, or workspaces it watches. The
 * channel is strictly downlink (the standing WebSocket carrier rule): substreams
 * open and close through ordinary unary POSTs, and a dropped downlink ends
 * every substream — each consumer's own recovery ladder then reopens onto a
 * fresh channel, preserving the per-family disconnect semantics exactly.
 */

import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'
import type { ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import type {
  EntityStreamFamily, EntityStreamOpenPayload, RpcId, RpcRequest, ServerRequest, StreamsFrame,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { CONNECTION_AUTHENTICATED_METHOD } from '@deepseek-ai/dsh-host-apiproxy/api'
import { streamsFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { authenticationPrincipalIdentitySchema, serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { STREAMS_EVENTS_PATH } from '../api-path.ts'
import type { TransportPathResolver } from './target.ts'
import { SocketRing } from './web-api-client.ts'
import { noteWebSocketClose, noteWebSocketOpen } from './connection-budget.ts'

type Parser<F> = { parse(value: unknown): F }

/** One queued delivery for a substream consumer. */
type SubItem =
  | { kind: 'ready' }
  | { kind: 'frame'; rpcId: RpcId; frame: unknown }
  | { kind: 'end'; failure?: Error }

/** Frames may arrive before their open POST resolves; the unclaimed pool bounds that window. */
const UNCLAIMED_FRAME_LIMIT = 256

interface SubRecord {
  readonly ring: SocketRing<SubItem>
  readonly callerSignal: AbortSignal
  readonly onOpen?: () => void
  readonly onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void
  identityDelivered: boolean
  wake: (() => void) | undefined
}

/** Construction inputs: everything the channel needs from its owning carrier client. */
export interface EntityStreamChannelDeps {
  /** Page token every substream binds (the same token mux presence uses). */
  readonly page: string
  /** Machine-generation signal: retirement closes the socket and ends every substream. */
  readonly channelSignal: AbortSignal
  /** Path rewriting bound to the channel's machine target. */
  readonly resolvePath: TransportPathResolver
  /** Base URL the downlink path resolves against. */
  readonly resolveBase: () => string
  /** Shared bootstrap authentication, awaited before the socket opens. */
  readonly authentication?: ClientAuthentication
  /** Opens one substream by family; rejects as an ordinary failed unary call. */
  readonly openControl: (payload: EntityStreamOpenPayload & { page: string }, signal: AbortSignal) => Promise<{ sub: string }>
  /** Closes one substream; idempotent server-side, best-effort client-side. */
  readonly closeControl: (payload: { page: string; sub: string }, signal: AbortSignal) => Promise<unknown>
  /** Diagnostics tap every parsed downlink message passes through. */
  readonly onEnvelope: (message: ServerRequest) => void
}

/**
 * One entity-stream downlink per machine generation. Not reconnecting by
 * itself is deliberate: substream consumers own their recovery pacing
 * (reattach ladders, watch backoff), and their next open call reopens the
 * socket lazily.
 */
export class EntityStreamChannel {
  private readonly deps: EntityStreamChannelDeps
  private socket: WebSocket | undefined
  private socketState: 'idle' | 'opening' | 'open' | 'closed' = 'idle'
  private socketOpening: Promise<void> | undefined
  private identity: AuthenticationPrincipalIdentity | undefined
  private readonly subs = new Map<string, SubRecord>()
  private readonly unclaimed = new Map<string, SubItem[]>()
  private unclaimedTotal = 0

  constructor(deps: EntityStreamChannelDeps) {
    this.deps = deps
    this.deps.channelSignal.addEventListener('abort', () => {
      this.socket?.close()
    }, { once: true })
  }

  /**
   * Open one substream and iterate its family frames. Frames are validated
   * against the caller's family schema at yield time; a malformed frame is
   * dropped (the standing carrier posture), not a stream failure.
   * @param family - the per-entity stream family producing the frames.
   * @param payload - the family's own stream-open payload, verbatim.
   * @param signal - caller cancellation; abort closes the substream.
   * @param schema - the family frame schema (the same schema its SSE carrier parsed with).
   * @param onOpen - fired when the substream is confirmed live.
   * @param onAuthenticated - fired once with the downlink's settled identity.
   * @returns the substream's frames in the narrow request form.
   */
  open<F>(
    family: EntityStreamFamily,
    payload: unknown,
    signal: AbortSignal,
    schema: Parser<F>,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncGenerator<RpcRequest<F>> {
    return this.stream(family, payload, signal, schema, onOpen, onAuthenticated)
  }

  /** The generator body of {@link open}; created lazily, iterated by the consumer. */
  private async *stream<F>(
    family: EntityStreamFamily,
    payload: unknown,
    signal: AbortSignal,
    schema: Parser<F>,
    onOpen?: () => void,
    onAuthenticated?: (identity: AuthenticationPrincipalIdentity) => void,
  ): AsyncGenerator<RpcRequest<F>> {
    {
      if (this.channelRetired() || this.callerAborted(signal)) return
      await this.ensureSocket()
      if (this.channelRetired() || this.callerAborted(signal)) return
      const opened = await this.deps.openControl({ page: this.deps.page, family, payload: payload as never }, signal)
      if (this.channelRetired() || signal.aborted) {
        this.closeQuietly(opened.sub)
        return
      }
      const rec: SubRecord = {
        ring: new SocketRing<SubItem>(),
        callerSignal: signal,
        ...(onOpen === undefined ? {} : { onOpen }),
        ...(onAuthenticated === undefined ? {} : { onAuthenticated }),
        identityDelivered: false,
        wake: undefined,
      }
      this.subs.set(opened.sub, rec)
      // A parked generator cannot observe the caller signal by itself (the
      // socket only wakes it on frames), so caller abort delivers the end
      // marker directly — silent, like an already-cancelled SSE fetch.
      const onCallerAbort = (): void => {
        rec.ring.push({ kind: 'end' })
        rec.wake?.()
        rec.wake = undefined
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      const buffered = this.unclaimed.get(opened.sub)
      if (buffered !== undefined) {
        this.unclaimed.delete(opened.sub)
        this.unclaimedTotal -= buffered.length
        for (const item of buffered) rec.ring.push(item)
      }
      if (this.identity !== undefined) {
        rec.identityDelivered = true
        try {
          onAuthenticated?.(this.identity)
        } catch (error) {
          console.error('[client-connection] entity-stream identity observer failed:', error)
        }
      }
      try {
        while (true) {
          if (this.channelRetired() || this.callerAborted(signal)) return
          while (rec.ring.length > 0) {
            const item = rec.ring.take() as SubItem
            if (item.kind === 'ready') {
              onOpen?.()
              continue
            }
            if (item.kind === 'end') {
              if (item.failure !== undefined) throw item.failure
              return
            }
            const frame = this.parseFrame(schema, item.frame)
            if (frame === undefined) continue
            yield { rpcId: item.rpcId, payload: frame }
          }
          await new Promise<void>((resolve) => { rec.wake = resolve })
        }
      } finally {
        signal.removeEventListener('abort', onCallerAbort)
        this.subs.delete(opened.sub)
        // Best-effort unsubscribe: a channel-level death (socket close,
        // generation retire) already reaped the substream server-side, so the
        // close call only matters while the channel is alive — every caller
        // exit (abort, break, or natural end) fires the idempotent close.
        if (!this.channelRetired()) {
          // Fire-and-forget: its failure swallow lives in closeQuietly.
          this.closeQuietly(opened.sub)
        }
      }
    }
  }

  /** Parse one family frame; a malformed frame drops (logged) instead of failing the stream. */
  private parseFrame<F>(schema: Parser<F>, frame: unknown): F | undefined {
    try {
      return schema.parse(frame)
    } catch (error) {
      console.error('[client-connection] dropping malformed entity-stream frame:', error)
      return undefined
    }
  }

  /** Whether the owning machine generation has retired (a consumer return can land before or after it). */
  private channelRetired(): boolean {
    return this.deps.channelSignal.aborted
  }

  /** Whether the caller cancelled (an abort while parked wakes the ring, not the signal read). */
  private callerAborted(signal: AbortSignal): boolean {
    return signal.aborted
  }

  /** Fire the idempotent close call and swallow its failure (teardown raced a dead channel). */
  private closeQuietly(sub: string): void {
    void this.deps.closeControl({ page: this.deps.page, sub }, this.deps.channelSignal)
      .catch(() => { /* the downlink's death reaps the substream server-side */ })
  }

  /** Track one frame for a substream whose open POST has not resolved yet. */
  private parkUnclaimed(sub: string, item: SubItem): void {
    if (this.unclaimedTotal >= UNCLAIMED_FRAME_LIMIT) {
      const oldest = this.unclaimed.keys().next().value
      if (oldest !== undefined) {
        this.unclaimedTotal -= this.unclaimed.get(oldest)?.length ?? 0
        this.unclaimed.delete(oldest)
      }
    }
    const parked = this.unclaimed.get(sub) ?? []
    parked.push(item)
    this.unclaimedTotal += 1
    this.unclaimed.set(sub, parked)
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (this.deps.channelSignal.aborted) return
    let full: ServerRequest
    let frame: StreamsFrame
    try {
      if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
      full = serverRequestSchema.parse(JSON.parse(event.data))
      if (full.method === CONNECTION_AUTHENTICATED_METHOD) {
        this.identity = authenticationPrincipalIdentitySchema.parse(full.payload)
        this.deliverIdentity()
        return
      }
      frame = streamsFrameSchema.parse(full.payload)
    } catch (error) {
      console.error('[client-connection] dropping malformed entity-stream downlink frame:', error)
      return
    }
    this.deps.onEnvelope(full)
    const item: SubItem = frame.type === 'sub/ready'
      ? { kind: 'ready' }
      : frame.type === 'sub/frame'
        ? { kind: 'frame', rpcId: full.rpcId, frame: frame.frame }
        : { kind: 'end', ...(frame.error === undefined ? {} : { failure: new Error(frame.error.message) }) }
    const rec = this.subs.get(frame.sub)
    if (rec === undefined) {
      this.parkUnclaimed(frame.sub, item)
      return
    }
    rec.ring.push(item)
    rec.wake?.()
    rec.wake = undefined
  }

  private readonly handleClose = (): void => {
    if (this.socketState !== 'closed') {
      this.socketState = 'closed'
      noteWebSocketClose()
    }
    this.socket = undefined
    this.unclaimed.clear()
    this.unclaimedTotal = 0
    const channelAborted = this.deps.channelSignal.aborted
    for (const rec of this.subs.values()) {
      // A substream whose caller already stopped ends silently; the rest see a
      // transport failure so their own recovery ladders engage — the same
      // distinction a dropped SSE connection produced.
      rec.ring.push({ kind: 'end', ...(channelAborted || rec.callerSignal.aborted ? {} : { failure: new Error('entity-stream downlink closed') }) })
      rec.wake?.()
      rec.wake = undefined
    }
  }

  /** Publish the settled identity to every substream waiting for it, exactly once each. */
  private deliverIdentity(): void {
    const identity = this.identity
    if (identity === undefined) return
    for (const rec of this.subs.values()) {
      if (rec.identityDelivered) continue
      rec.identityDelivered = true
      try {
        rec.onAuthenticated?.(identity)
      } catch (error) {
        console.error('[client-connection] entity-stream identity observer failed:', error)
      }
    }
  }

  private ensureSocket(): Promise<void> {
    if (this.socketState === 'open') return Promise.resolve()
    if (this.socketOpening !== undefined) return this.socketOpening
    const opening = (async (): Promise<void> => {
      await this.deps.authentication?.ready(this.deps.channelSignal)
      const url = new URL(
        this.deps.resolvePath(`${STREAMS_EVENTS_PATH}?page=${encodeURIComponent(this.deps.page)}`),
        this.deps.resolveBase(),
      )
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url)
      noteWebSocketOpen()
      this.socket = socket
      this.socketState = 'opening'
      socket.addEventListener('message', this.handleMessage)
      socket.addEventListener('close', this.handleClose, { once: true })
      try {
        await new Promise<void>((resolve, reject) => {
          const settle = (cleanly: boolean): void => {
            socket.removeEventListener('open', onOpen)
            socket.removeEventListener('error', onError)
            this.deps.channelSignal.removeEventListener('abort', onAbort)
            if (cleanly) resolve()
            else reject(new Error('entity-stream downlink WebSocket failed to open'))
          }
          const onOpen = (): void => { settle(true) }
          const onError = (): void => { settle(false) }
          const onAbort = (): void => {
            socket.close()
            settle(false)
          }
          socket.addEventListener('open', onOpen, { once: true })
          socket.addEventListener('error', onError, { once: true })
          this.deps.channelSignal.addEventListener('abort', onAbort, { once: true })
        })
        if (this.deps.channelSignal.aborted) {
          socket.close()
          throw new Error('entity-stream downlink retired before opening')
        }
        this.socketState = 'open'
      } catch (error) {
        // A failed attempt leaves no half-open state: the socket never carried
        // a substream, so the budget slot is released here and the close
        // listener's own guard sees a settled channel.
        socket.removeEventListener('message', this.handleMessage)
        this.socketState = 'closed'
        this.socket = undefined
        noteWebSocketClose()
        throw error
      }
    })()
    const forget = (): void => { this.socketOpening = undefined }
    opening.then(forget, forget)
    this.socketOpening = opening
    return opening
  }
}
