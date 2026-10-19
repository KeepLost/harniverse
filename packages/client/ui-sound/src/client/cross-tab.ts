/**
 * Cross-tab sound arbitration over one BroadcastChannel: tabs announce play
 * intents and the peer with the larger random nonce defers, so a notification
 * heard by N open tabs rings exactly once. A lone tab plays immediately with
 * no handshake; the channel stays optional and absent support degrades to
 * always-play.
 */

/** Message shapes shared by every participant. */
export type CrossTabMessage =
  | { t: 'hello' }
  | { t: 'hello-ack' }
  | { t: 'intent'; key: string; nonce: number }

/** Structural channel face (BroadcastChannel in production). */
export interface CrossTabChannel {
  postMessage(message: CrossTabMessage): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

/** Window when a deferred intent fires unless a peer claims the same key. */
export const CROSS_TAB_HANDSHAKE_MS = 40

/**
 * One tab's arbitration participant.
 */
export class CrossTabDedupe {
  private readonly pending = new Map<string, { nonce: number; timer: unknown }>()
  private peerSeen = false

  /**
   * @param channel - the shared channel; undefined disables arbitration.
   * @param schedule - timer injectable for tests.
   * @param cancel - timer canceller paired with schedule.
   */
  constructor(
    private readonly channel: CrossTabChannel | undefined,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => { return setTimeout(fn, ms) },
    private readonly cancel: (timer: unknown) => void = (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
  ) {
    if (channel === undefined) return
    channel.onmessage = (event) => { this.receive(event.data) }
    this.post({ t: 'hello' })
  }

  /**
   * Play one keyed sound through arbitration.
   *
   * @param key - the event occurrence's dedupe key.
   * @param play - the immediate playback callback.
   */
  declare(key: string, play: () => void): void {
    if (this.channel === undefined) {
      play()
      return
    }
    if (!this.peerSeen) {
      this.post({ t: 'intent', key, nonce: 0 })
      play()
      return
    }
    const nonce = Math.random()
    const timer = this.schedule(() => {
      this.pending.delete(key)
      play()
    }, CROSS_TAB_HANDSHAKE_MS)
    this.pending.set(key, { nonce, timer })
    this.post({ t: 'intent', key, nonce })
  }

  /** Tear the participant down and drop every deferred intent. */
  dispose(): void {
    for (const { timer } of this.pending.values()) this.cancel(timer)
    this.pending.clear()
    this.channel?.close()
  }

  /** Handle one inbound message from a peer tab. */
  private receive(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const data = message as { t?: unknown; key?: unknown; nonce?: unknown }
    if (data.t === 'hello') {
      this.peerSeen = true
      this.post({ t: 'hello-ack' })
      return
    }
    if (data.t === 'hello-ack') {
      this.peerSeen = true
      return
    }
    if (data.t !== 'intent' || typeof data.key !== 'string') return
    this.peerSeen = true
    const mine = this.pending.get(data.key)
    if (mine !== undefined && typeof data.nonce === 'number' && mine.nonce > data.nonce) {
      this.cancel(mine.timer)
      this.pending.delete(data.key)
    }
  }

  /** Post one message, swallowing a channel that closed underneath us. */
  private post(message: CrossTabMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      /* the channel closed; playback degrades to always-play */
    }
  }
}
