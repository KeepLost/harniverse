/** Peer event stream: single-use stream tokens and the SSE push channel. */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { PEER_NONCE_TTL_MS, PEER_STREAM_HEARTBEAT_MS, PEER_STREAM_TOKEN_TTL_MS } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerEventFrame, PeerInstanceId, PeerSubscribeResult } from '@deepseek-ai/dsh-peer-protocol'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { readPeerSessions } from './session-registry.ts'

/** Upper bound on simultaneously outstanding stream tokens. */
const MAX_PENDING_STREAM_TOKENS = 256

/** Bucket bound on one peer's retained consumed nonces; memory hygiene, not a replay window. */
const MAX_CONSUMED_NONCES = 256

/** Outstanding single-use stream tokens by token value. */
interface PendingStreamToken {
  instanceId: PeerInstanceId
  expiresAt: number
}

/** Mint and redeem single-use stream tokens binding one event stream to an authenticated peer. */
export class PeerStreamTokens {
  private readonly pending = new Map<string, PendingStreamToken>()

  /**
   * Mint one stream token for an authenticated peer.
   * @param instanceId - the verified calling peer.
   * @param now - current epoch milliseconds.
   * @returns the subscribe result carrying the token and heartbeat cadence.
   */
  mint(instanceId: PeerInstanceId, now: number): PeerSubscribeResult {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token)
    }
    if (this.pending.size >= MAX_PENDING_STREAM_TOKENS) {
      this.pending.delete(this.pending.keys().next().value as string)
    }
    const streamToken = randomBytes(24).toString('base64url')
    this.pending.set(streamToken, { instanceId, expiresAt: now + PEER_STREAM_TOKEN_TTL_MS })
    return { streamToken, heartbeatMs: PEER_STREAM_HEARTBEAT_MS }
  }

  /**
   * Redeem one stream token exactly once.
   * @param streamToken - the token presented at the stream route.
   * @param now - current epoch milliseconds.
   * @returns the bound peer identity, or `undefined` for an unknown, expired, or already-redeemed token.
   */
  redeem(streamToken: string, now: number): PeerInstanceId | undefined {
    const entry = this.pending.get(streamToken)
    if (entry === undefined) return undefined
    this.pending.delete(streamToken)
    return entry.expiresAt > now ? entry.instanceId : undefined
  }
}

/** Replay guard for request-proof nonces: first use wins, replays inside the skew window reject. */
export class PeerNonceLedger {
  private readonly consumed = new Map<PeerInstanceId, Map<string, number>>()

  /**
   * Record one verified nonce as consumed.
   * @param instanceId - the calling peer whose bucket holds the nonce.
   * @param nonce - the verified proof nonce.
   * @param now - current epoch milliseconds.
   * @returns whether the nonce was fresh; `false` names a replay.
   */
  consume(instanceId: PeerInstanceId, nonce: string, now: number): boolean {
    let bucket = this.consumed.get(instanceId)
    if (bucket === undefined) {
      bucket = new Map<string, number>()
      this.consumed.set(instanceId, bucket)
    }
    for (const [entry, expiresAt] of bucket) {
      if (expiresAt <= now) bucket.delete(entry)
    }
    if (bucket.has(nonce)) return false
    bucket.set(nonce, now + PEER_NONCE_TTL_MS)
    while (bucket.size > MAX_CONSUMED_NONCES) bucket.delete(bucket.keys().next().value as string)
    return true
  }
}

/** Encode one push frame as a server-sent-event data line.
 * @param frame - the push frame to carry.
 * @returns the complete `data:` chunk including its blank-line terminator.
 */
export function encodePeerEventFrame(frame: PeerEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/** Resolve the session ids one peer owns, for stream filtering. */
async function ownedSessionIds(home: string, instanceId: PeerInstanceId): Promise<Set<string>> {
  const sessions = await readPeerSessions(home)
  const owned = new Set<string>()
  for (const entry of sessions) {
    if (entry.peerInstanceId === instanceId) owned.add(entry.sessionId)
  }
  return owned
}

/** Why one event stream ended. */
export type PeerEventStreamEnd = 'closed' | 'write-failed'

/** Options of {@link runPeerEventStream}. */
export interface PeerEventStreamOptions {
  /** Host context whose `session/event` bus feeds the stream. */
  ctx: Context
  /** Absolute Harness home holding the session registry. */
  home: string
  /** The subscribed peer; only its sessions stream. */
  instanceId: PeerInstanceId
  /** Sink for SSE chunks; a throw marks the stream dead. */
  write(chunk: string): void
  /** Abort that ends the stream. */
  signal: AbortSignal
  /** Heartbeat cadence override; one seam for tests. */
  heartbeatMs?: number
}

/**
 * Serve one peer's event stream: settlement push frames for the peer's own
 * sessions plus heartbeat comments, until aborted. The frames are wake-up
 * signals only — settlements stay derived from `peer/result` reads.
 * @param options - context, home, identity, sink, and abort.
 * @returns why the stream ended.
 */
export async function runPeerEventStream(options: PeerEventStreamOptions): Promise<PeerEventStreamEnd> {
  const heartbeatMs = options.heartbeatMs ?? PEER_STREAM_HEARTBEAT_MS
  let owned = await ownedSessionIds(options.home, options.instanceId)
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  let writeFailed = false
  // A closure read keeps the terminal narrowing honest: the flag flips inside
  // `send`, after the checks control-flow analysis can still see.
  const failed = (): boolean => writeFailed
  const send = (chunk: string): (void) => {
    if (failed()) return
    try {
      options.write(chunk)
    } catch {
      // A write into a closed sink ends the stream; the try contains the late
      // listener delivery between abort and cleanup.
      writeFailed = true
      controller.abort()
    }
  }
  const off = options.ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end' || !owned.has(session.id)) return
    send(encodePeerEventFrame({ kind: 'settled', sessionId: session.id }))
  })
  const heartbeat = setInterval(() => {
    send(': peer\n\n')
    void ownedSessionIds(options.home, options.instanceId).then((next) => {
      owned = next
    })
  }, heartbeatMs)
  ;(heartbeat as { unref?: () => void }).unref?.()
  try {
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        resolve()
      }, { once: true })
    })
  } finally {
    clearInterval(heartbeat)
    off()
    options.signal.removeEventListener('abort', abort)
  }
  return failed() ? 'write-failed' : 'closed'
}
