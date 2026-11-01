/**
 * Wire protocol constants and message shapes for the micro-VM control channel.
 *
 * Both directions travel as length-prefixed JSON frames (see `frame.ts`). The
 * host opens with `hello`; the guest answers `welcome`, or `error` with code
 * `version` and closes the port when it does not speak the host's version.
 * Every later `hello` on the same connection is validated the same way, so a
 * mismatched client is rejected at any point in the session.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

/** Single protocol version this seed speaks; peers must match it exactly. */
export const PROTOCOL_VERSION = 1

/** Capability the host announces in `hello`; the M0 host answers ping only. */
export const HOST_CAPS = ['ping'] as const

/** Host greeting; the guest answers `welcome`, or rejects the version. */
export interface HelloMessage {
  t: 'hello'
  v: number
  caps: readonly string[]
}

/** Guest answer to an accepted `hello`. */
export interface WelcomeMessage {
  t: 'welcome'
  v: number
  caps: readonly string[]
  agent: string
}

/** Unsolicited readiness beacon the guest repeats until its first decoded host frame. */
export interface AnnounceMessage {
  t: 'announce'
  v: number
  caps: readonly string[]
  agent: string
}

/** Round-trip probe carrying an echo number. */
export interface PingMessage {
  t: 'ping'
  n: number
}

/** Guest answer echoing the ping number. */
export interface PongMessage {
  t: 'pong'
  n: number
}

/** Host request for the guest to power the world off. */
export interface ShutdownMessage {
  t: 'shutdown'
}

/** Guest rejection with a machine-readable code. */
export interface ErrorMessage {
  t: 'error'
  code: 'version' | 'unknown-message'
  minV?: number
  maxV?: number
  message?: string
}

/** Messages the host may send. */
export type HostMessage = HelloMessage | PingMessage | ShutdownMessage
/** Messages the guest may send. */
export type GuestMessage = WelcomeMessage | AnnounceMessage | PongMessage | ErrorMessage

/**
 * Compare a guest hello version against the host protocol version.
 * @param hostV - protocol version the host speaks.
 * @param guestV - protocol version the guest hello announced.
 * @returns agreement on exact match, rejection with both versions otherwise.
 */
export function negotiateVersion(
  hostV: number,
  guestV: number,
): { ok: true; version: number } | { ok: false; reason: 'version-mismatch'; hostV: number; guestV: number } {
  if (hostV === guestV) return { ok: true, version: hostV }
  return { ok: false, reason: 'version-mismatch', hostV, guestV }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Parse one guest reply from its JSON payload.
 * @param payload - decoded UTF-8 frame payload.
 * @returns the typed guest message, or `undefined` when the payload is not a
 * guest message this host understands.
 */
export function parseGuestMessage(payload: string): GuestMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const message = parsed as Record<string, unknown>
  const t = message.t
  if (t === 'welcome' || t === 'announce') {
    if (typeof message.v !== 'number' || typeof message.agent !== 'string' || !isStringArray(message.caps)) return undefined
    return { t, v: message.v, caps: message.caps, agent: message.agent }
  }
  if (t === 'pong') {
    if (typeof message.n !== 'number') return undefined
    return { t: 'pong', n: message.n }
  }
  if (t === 'error') {
    if (message.code !== 'version' && message.code !== 'unknown-message') return undefined
    const error: ErrorMessage = { t: 'error', code: message.code }
    if (typeof message.minV === 'number') error.minV = message.minV
    if (typeof message.maxV === 'number') error.maxV = message.maxV
    if (typeof message.message === 'string') error.message = message.message
    return error
  }
  return undefined
}
