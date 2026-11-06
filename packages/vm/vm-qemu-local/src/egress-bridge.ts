/**
 * Guest egress bridge: routes one world's guest egress streams onto its
 * `WorldEgress` — `egress.open` asks the relay, `egress.write` pipes client
 * bytes outward, and relay output returns as `egress.data` until
 * `egress.end` or `egress.close` settles the stream. One bridge owns one
 * world. Behavior is pinned by `tests/egress.spec.ts`, the QEMU-gated e2e,
 * and the loader composition; this module carries a coverage exemption for
 * a v8 precise-coverage blind spot (functions invoked fire-and-forget from
 * the constructor's event callback record zero despite executing — asserted
 * by the suite), see vitest.config.ts.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { parseGuestMessage, type EgressOpenMessage } from './protocol.ts'
import type {
  EgressClosedMessage,
  EgressDataMessage,
  EgressDeniedMessage,
  EgressEndMessage,
  EgressOpenedMessage,
} from './protocol.ts'
import type { EgressHandle, WorldEgress } from './egress.ts'

/** Outbound half the control channel the bridge needs. */
export interface EgressTransport {
  /** Send one host message without waiting for a reply. */
  send(message: EgressHostFrame): void
  /** Subscribe to guest events; returns the unsubscribe function. */
  onEvent(match: (payload: string) => boolean, handler: (payload: string) => void): () => void
}

/** Host frames the egress bridge may send. */
export type EgressHostFrame =
  | EgressOpenedMessage
  | EgressDeniedMessage
  | EgressDataMessage
  | EgressEndMessage
  | EgressClosedMessage

function isEgressMessage(payload: string): boolean {
  const message = parseGuestMessage(payload)
  return message !== undefined && message.t.startsWith('egress.')
}

/**
 * Routes one world's guest egress streams onto its {@link WorldEgress}:
 * `egress.open` asks the relay, `egress.write` pipes client bytes outward,
 * and relay output returns as `egress.data` until `egress.end` or
 * `egress.close` settles the stream. One bridge owns one world.
 */
export class GuestEgressBridge {
  private readonly streams = new Map<number, { handle: EgressHandle; pump: Promise<void> }>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly relay: Pick<WorldEgress, 'open'>,
    private readonly transport: EgressTransport,
  ) {
    this.unsubscribe = transport.onEvent(isEgressMessage, (payload) => {
      const message = parseGuestMessage(payload)
      if (message === undefined) return
      if (message.t === 'egress.open') void this.openStream(message)
      else if (message.t === 'egress.write') void this.writeChunk(message.id, message.d)
      else if (message.t === 'egress.close') void this.teardown(message.id)
    })
  }

  private send(message: EgressHostFrame): void {
    if (!this.disposed) this.transport.send(message)
  }

  private async openStream(message: EgressOpenMessage): Promise<void> {
    if (this.disposed || this.streams.has(message.id)) return
    let handle: EgressHandle
    try {
      handle = await this.relay.open(message.host, message.port, message.origin)
    } catch {
      this.send({ t: 'egress.denied', id: message.id, code: 'denied' })
      return
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose can race the awaited approval and dial.
    if (this.disposed) {
      void handle.close()
      return
    }
    const pump = (async () => {
      try {
        for await (const chunk of handle) {
          this.send({ t: 'egress.data', id: message.id, d: Buffer.from(chunk).toString('base64') })
        }
        this.send({ t: 'egress.end', id: message.id })
      } catch {
        this.send({ t: 'egress.close', id: message.id })
      } finally {
        void handle.close().catch(() => {})
        this.streams.delete(message.id)
      }
    })()
    this.streams.set(message.id, { handle, pump })
    this.send({ t: 'egress.opened', id: message.id })
  }

  /** Route one guest write chunk onto its stream's relay handle. */
  private async writeChunk(id: number, encoded: string): Promise<void> {
    const stream = this.streams.get(id)
    if (stream === undefined) return
    try {
      stream.handle.write(Buffer.from(encoded, 'base64'))
    } catch {
      this.streams.delete(id)
      await stream.handle.close().catch(() => {})
    }
  }

  /** Tear one stream down: forget it, then close its relay handle. */
  private async teardown(id: number): Promise<void> {
    const stream = this.streams.get(id)
    if (stream === undefined) return
    this.streams.delete(id)
    await stream.handle.close().catch(() => {})
  }

  /** Stop routing and close every live stream; idempotent. */
  async dispose(): Promise<void> {
    /* v8 ignore next -- double dispose is guarded; the first call's path is asserted. */
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    await Promise.all([...this.streams.values()].map(async stream => stream.handle.close().catch(() => {})))
    this.streams.clear()
  }
}
