/**
 * Wire protocol constants and message shapes for the micro-VM control channel.
 *
 * Both directions travel as length-prefixed JSON frames (see `frame.ts`). The
 * host opens with `hello`; the guest answers `welcome`, or `error` with code
 * `version` and closes the port when it does not speak the host's version.
 * Every later `hello` on the same connection is validated the same way, so a
 * mismatched client is rejected at any point in the session.
 *
 * Version 2 added the exec and fs operations: exec requests are acknowledged
 * by `exec.started` and then stream `exec.out` frames until one `exec.exit`;
 * fs requests are one round trip each (`fs.ok` or `fs.err`). Binary payloads
 * (`d` fields) travel base64-encoded so frames stay valid UTF-8.
 *
 * Version 3 adds the workspace data-plane operations: `workspace.import`
 * unpacks the staged import image into the guest's `/workspace` and
 * `workspace.export` packs that directory into the export image; each is
 * answered exactly once by `workspace.ok` (with the payload size) or
 * `workspace.err` (including the `busy` guard while another transfer runs).
 *
 * Version 3 also carries the guest egress surface: an `exec` may carry an
 * `origin` token, which binds a per-exec SOCKS5 loopback listener inside the
 * guest (advertised to the child through `ALL_PROXY`); a client connection
 * asks the host with `egress.open`, the host answers `egress.opened` or
 * `egress.denied`, and both directions stream as base64 `egress.write` /
 * `egress.data` chunks until `egress.end` (orderly EOF) or `egress.close`
 * (teardown) settles the stream in each direction.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

/** Single protocol version this host speaks; peers must match it exactly. */
export const PROTOCOL_VERSION = 3

/** Capabilities the host announces in `hello`; the M1 host answers ping, exec, and fs. */
export const HOST_CAPS = ['ping', 'exec', 'fs', 'workspace'] as const

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

/** Terminal size a pty exec should start with. */
export interface PtySize {
  rows: number
  cols: number
}

/** Start one guest process; the guest answers `exec.started` or `exec.err`. */
export interface ExecMessage {
  t: 'exec'
  id: number
  argv: string[]
  env?: Record<string, string>
  cwd?: string
  pty?: PtySize
  /** Egress-origin token; when present the child gets a per-exec SOCKS5 loopback listener. */
  origin?: string
}

/** One base64 stdin chunk for a live exec. */
export interface ExecStdinMessage {
  t: 'exec.stdin'
  id: number
  d: string
}

/** End a live exec's stdin (the child then reads EOF). */
export interface ExecStdinCloseMessage {
  t: 'exec.stdin.close'
  id: number
}

/** Deliver a signal to a live exec; the guest answers `exec.acked` or `exec.err`. */
export interface ExecSignalMessage {
  t: 'exec.signal'
  id: number
  sig: string
}

/** One fs operation; `op` selects the shape of the remaining fields. */
export type FsWireOp =
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; d: string }
  | { op: 'stat'; path: string }
  | { op: 'list'; path: string }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'unlink'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'rename'; from: string; to: string }

/**
 * One fs round trip; the op fields travel FLAT in this object (matching the
 * guest's flattened serde shape), and the guest answers `fs.ok` or `fs.err`
 * with the same id.
 */
export type FsMessage = { t: 'fs'; id: number } & FsWireOp

/** Unpack the staged import image into the guest's `/workspace`. */
export interface WorkspaceImportMessage {
  t: 'workspace.import'
  id: number
}

/** Pack the guest's `/workspace` into the export image. */
export interface WorkspaceExportMessage {
  t: 'workspace.export'
  id: number
}

/** Host approval of one guest egress stream; data may then flow both ways. */
export interface EgressOpenedMessage {
  t: 'egress.opened'
  id: number
}

/** Host refusal of one guest egress stream; `code` names why. */
export interface EgressDeniedMessage {
  t: 'egress.denied'
  id: number
  code: string
}

/** One base64 inbound chunk (remote → guest client) of a live egress stream. */
export interface EgressDataMessage {
  t: 'egress.data'
  id: number
  d: string
}

/** Remote EOF on a live egress stream; the guest client then reads EOF. */
export interface EgressEndMessage {
  t: 'egress.end'
  id: number
}

/** Host-side teardown of a live egress stream; the guest client socket closes. */
export interface EgressCloseMessage {
  t: 'egress.close'
  id: number
}

/** Messages the host may send. */
export type HostMessage =
  | HelloMessage
  | PingMessage
  | ShutdownMessage
  | ExecMessage
  | ExecStdinMessage
  | ExecStdinCloseMessage
  | ExecSignalMessage
  | FsMessage
  | WorkspaceImportMessage
  | WorkspaceExportMessage
  | EgressOpenedMessage
  | EgressDeniedMessage
  | EgressDataMessage
  | EgressEndMessage
  | EgressCloseMessage

/** Guest ack for an accepted exec; `pid` is the guest-side process id. */
export interface ExecStartedMessage {
  t: 'exec.started'
  id: number
  pid: number
}

/** One output chunk of a live exec; `s` selects stdout (`o`) or stderr (`e`). */
export interface ExecOutMessage {
  t: 'exec.out'
  id: number
  s: 'o' | 'e'
  d: string
}

/** Final state of one exec; `sig` names the fatal signal when there was one. */
export interface ExecExitMessage {
  t: 'exec.exit'
  id: number
  code: number
  sig?: string
}

/** Guest ack that a signal was delivered. */
export interface ExecAckedMessage {
  t: 'exec.acked'
  id: number
}

/** Guest rejection of an exec request (bad argv, spawn failure, unknown id). */
export interface ExecErrMessage {
  t: 'exec.err'
  id: number
  message: string
}

/** Guest file facts; `mtimeMs` is epoch milliseconds. */
export interface FsStatWire {
  kind: 'file' | 'dir'
  size: number
  mode: number
  mtimeMs: number
}

/** One directory entry in a `fs.ok` list reply. */
export interface FsEntryWire {
  name: string
  kind: 'file' | 'dir'
}

/** Successful fs reply; the op determines which field is present. */
export interface FsOkMessage {
  t: 'fs.ok'
  id: number
  d?: string
  entries?: FsEntryWire[]
  st?: FsStatWire
}

/** Failed fs reply with the guest errno. */
export interface FsErrMessage {
  t: 'fs.err'
  id: number
  errno: number
  message: string
}

/** Completed workspace transfer; `bytes` is the payload size that moved. */
export interface WorkspaceOkMessage {
  t: 'workspace.ok'
  id: number
  bytes: number
}

/** Failed workspace transfer (missing device, tar failure, or `busy`). */
export interface WorkspaceErrMessage {
  t: 'workspace.err'
  id: number
  message: string
}

/** Guest rejection with a machine-readable code. */
export interface ErrorMessage {
  t: 'error'
  code: 'version' | 'unknown-message'
  minV?: number
  maxV?: number
  message?: string
}

/** Guest request to open one egress stream through the host relay. */
export interface EgressOpenMessage {
  t: 'egress.open'
  id: number
  host: string
  port: number
  /** Egress-origin token of the exec whose listener accepted the client. */
  origin?: string
}

/** One base64 outbound chunk (guest client → remote) of a live egress stream. */
export interface EgressWriteMessage {
  t: 'egress.write'
  id: number
  d: string
}

/** Guest-side teardown of one egress stream (client EOF or error). */
export interface EgressClosedMessage {
  t: 'egress.close'
  id: number
}

/** Messages the guest may send. */
export type GuestMessage =
  | WelcomeMessage
  | AnnounceMessage
  | PongMessage
  | ErrorMessage
  | ExecStartedMessage
  | ExecOutMessage
  | ExecExitMessage
  | ExecAckedMessage
  | ExecErrMessage
  | FsOkMessage
  | FsErrMessage
  | WorkspaceOkMessage
  | WorkspaceErrMessage
  | EgressOpenMessage
  | EgressWriteMessage
  | EgressClosedMessage

/** Guest messages that answer or report on one exec, fs, or workspace id. */
export type GuestOpMessage =
  | ExecStartedMessage
  | ExecOutMessage
  | ExecExitMessage
  | ExecAckedMessage
  | ExecErrMessage
  | FsOkMessage
  | FsErrMessage
  | WorkspaceOkMessage
  | WorkspaceErrMessage
  | EgressOpenMessage
  | EgressWriteMessage
  | EgressClosedMessage

/**
 * Narrow channel contract the exec and fs surfaces drive; the world's control
 * channel implements it and tests may substitute scripted fakes.
 */
export interface ControlTransport {
  /** Send one host message without waiting for a reply. */
  send(message: HostMessage): void
  /**
   * Send one host message and await the first matching reply.
   * @param message - host message to send.
   * @param match - reply predicate; the first matching payload resolves.
   * @param timeoutMs - reply deadline.
   */
  request(message: HostMessage, match: (payload: string) => boolean, timeoutMs: number): Promise<string>
  /** Subscribe to unsolicited guest events; returns the unsubscribe function. */
  onEvent(match: (payload: string) => boolean, handler: (payload: string) => void): () => void
  /** Observe the channel closing or failing; returns the unsubscribe function. */
  onClose(handler: (error: Error) => void): () => void
}

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

/**
 * Test whether a payload is a parseable op reply for one id of the given types.
 * @param payload - decoded frame payload.
 * @param id - exec/fs id the reply must carry.
 * @param types - accepted message tags.
 * @returns true when the payload parses as one of `types` with `id`.
 */
export function isOpReplyFor(payload: string, id: number, types: readonly string[]): boolean {
  const message = parseGuestMessage(payload)
  return message !== undefined && 'id' in message && message.id === id && types.includes(message.t)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function hasId(message: Record<string, unknown>): message is Record<string, unknown> & { id: number } {
  return typeof message.id === 'number'
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
    return { t, n: message.n }
  }
  if (t === 'error') {
    if (message.code !== 'version' && message.code !== 'unknown-message') return undefined
    const error: ErrorMessage = { t, code: message.code }
    if (typeof message.minV === 'number') error.minV = message.minV
    if (typeof message.maxV === 'number') error.maxV = message.maxV
    if (typeof message.message === 'string') error.message = message.message
    return error
  }
  if (t === 'exec.started') {
    if (!hasId(message) || typeof message.pid !== 'number') return undefined
    return { t, id: message.id, pid: message.pid }
  }
  if (t === 'exec.acked') {
    if (!hasId(message)) return undefined
    return { t, id: message.id }
  }
  if (t === 'exec.out') {
    if (!hasId(message) || (message.s !== 'o' && message.s !== 'e') || typeof message.d !== 'string') return undefined
    return { t, id: message.id, s: message.s, d: message.d }
  }
  if (t === 'exec.exit') {
    if (!hasId(message) || typeof message.code !== 'number') return undefined
    const exit: ExecExitMessage = { t, id: message.id, code: message.code }
    if (typeof message.sig === 'string') exit.sig = message.sig
    return exit
  }
  if (t === 'exec.err') {
    if (!hasId(message) || typeof message.message !== 'string') return undefined
    return { t, id: message.id, message: message.message }
  }
  if (t === 'fs.ok') {
    if (!hasId(message)) return undefined
    const ok: FsOkMessage = { t, id: message.id }
    if (typeof message.d === 'string') ok.d = message.d
    if (Array.isArray(message.entries)) {
      const entries: FsEntryWire[] = []
      for (const entry of message.entries) {
        if (typeof entry !== 'object' || entry === null) return undefined
        const record = entry as Record<string, unknown>
        if (typeof record.name !== 'string' || (record.kind !== 'file' && record.kind !== 'dir')) return undefined
        entries.push({ name: record.name, kind: record.kind })
      }
      ok.entries = entries
    }
    if (typeof message.st === 'object' && message.st !== null) {
      const record = message.st as Record<string, unknown>
      if (
        (record.kind !== 'file' && record.kind !== 'dir')
        || typeof record.size !== 'number'
        || typeof record.mode !== 'number'
        || typeof record.mtimeMs !== 'number'
      ) return undefined
      ok.st = { kind: record.kind, size: record.size, mode: record.mode, mtimeMs: record.mtimeMs }
    }
    return ok
  }
  if (t === 'fs.err') {
    if (!hasId(message) || typeof message.errno !== 'number' || typeof message.message !== 'string') return undefined
    return { t, id: message.id, errno: message.errno, message: message.message }
  }
  if (t === 'workspace.ok') {
    if (!hasId(message) || typeof message.bytes !== 'number') return undefined
    return { t, id: message.id, bytes: message.bytes }
  }
  if (t === 'workspace.err') {
    if (!hasId(message) || typeof message.message !== 'string') return undefined
    return { t, id: message.id, message: message.message }
  }
  if (t === 'egress.open') {
    if (!hasId(message) || typeof message.host !== 'string' || typeof message.port !== 'number') return undefined
    const open: EgressOpenMessage = { t, id: message.id, host: message.host, port: message.port }
    if (typeof message.origin === 'string') open.origin = message.origin
    return open
  }
  if (t === 'egress.write') {
    if (!hasId(message) || typeof message.d !== 'string') return undefined
    return { t, id: message.id, d: message.d }
  }
  if (t === 'egress.close') {
    if (!hasId(message)) return undefined
    return { t, id: message.id }
  }
  return undefined
}
