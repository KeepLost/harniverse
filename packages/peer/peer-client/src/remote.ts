/** Authenticated peer Remote calls: the shared envelope, proofs, and the delegate/follow-up/enumeration operations. */

import { randomBytes, randomUUID } from 'node:crypto'
import { GrantAccess } from '@deepseek-ai/dsh-sdk-client'
import {
  PeerError,
  peerHelloMessage,
  peerRequestMessage,
} from '@deepseek-ai/dsh-peer-protocol'
import type { PeerErrorReason, PeerEventFrame, PeerInstanceId, PeerRequestProof, PeerRunResult, PeerSessionSummary, PeerSubscribeResult, PeerSurface, PeerSurfaceResult, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { pinnedFetchFor } from './transport.ts'
import type { PeerKeyMaterial } from './keys.ts'

/** Inputs of one Remote call run; the caller owns transport establishment. */
export interface PeerCallOptions {
  /** The paired target record carrying the Grant identity. */
  target: PeerTarget
  /** Absolute initiator Harness home holding the identity key. */
  home: string
  /** Origin the target endpoint resolves to for this run: the direct origin, or `http://127.0.0.1:<forwardPort>` behind a tunnel. */
  origin: string
  /** Fetch implementation bound to the transport; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Request timeout applied to each Remote call. */
  timeoutMs?: number
}

/** The initiator's resolved call identity: home key plus its instance anchor. */
export interface PeerCallIdentity {
  instanceId: PeerInstanceId
  key: PeerKeyMaterial
}

/**
 * Mint one single-use nonce-bound request proof.
 * @param identity - the initiator's key and instance anchor.
 * @returns the signed proof for the next Remote call.
 */
export async function requestProofFor(identity: PeerCallIdentity): Promise<PeerRequestProof> {
  const timestamp = Date.now()
  const nonce = randomBytes(16).toString('base64url')
  const message = peerRequestMessage(identity.instanceId, timestamp, nonce)
  return { instanceId: identity.instanceId, timestamp, nonce, signature: await identity.key.signChallenge(message) }
}

/**
 * Build one Grant-backed transport for a stored target.
 * @param options - target, origin, and limits.
 * @param key - the initiator's signing identity.
 * @returns the authenticated transport.
 */
export function accessFor(options: PeerCallOptions, key: PeerKeyMaterial): GrantAccess {
  const timeout = options.timeoutMs ?? 30_000
  const fetchImpl = bounded(pinnedFetchFor(options.target.tlsFingerprint, options.origin,
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))), timeout)
  return new GrantAccess({ origin: options.origin, grantId: options.target.grantId,
    signChallenge: payload => key.signChallenge(payload), fetch: fetchImpl })
}

/**
 * Call one peer Remote method through the authenticated Connection RPC envelope.
 * @param access - the target's Grant-backed transport.
 * @param origin - exact target origin.
 * @param method - Remote method name in the `peer` namespace.
 * @param args - the method's single argument value.
 * @returns the method's response value.
 * @throws a {@link PeerError} carrying the server's closed reason, or `TRANSPORT_FAILED`/`HELLO_REJECTED` for transport faults.
 */
export async function callPeerRemote(access: GrantAccess, origin: string, method: string, args: unknown): Promise<unknown> {
  const rpcId = randomUUID()
  let response: Response
  try {
    response = await access.fetch(`${origin}/api/peer/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: `peer/${method}`, payload: { args } }),
    })
  } catch (error) {
    // The Grant's challenge/token exchange rejects revoked grants with a raw
    // sdk-client Error; surface the closed re-pair guidance instead.
    if (error instanceof Error && error.message.startsWith('GrantAccess:')) {
      throw new PeerError('EXCHANGE_FAILED', 'grant rejected; remove the stale target record and re-pair with a fresh invitation')
    }
    // A transport-level throw (refused connection, DNS, abort) names the same
    // family as an HTTP-level fault so callers classify reachability once.
    const detail = error instanceof Error ? error.message : String(error)
    throw method === 'hello' ? new PeerError('HELLO_REJECTED', detail) : new PeerError('TRANSPORT_FAILED', detail)
  }
  const transportFault = (detail: string): PeerError =>
    method === 'hello' ? new PeerError('HELLO_REJECTED', detail) : new PeerError('TRANSPORT_FAILED', detail)
  if (!response.ok) throw transportFault(`HTTP ${String(response.status)}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw transportFault('non-JSON response')
  }
  const record = body as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown; error?: { message?: unknown } } }
  if (record.type !== 'server-response' || record.rpcId !== rpcId || record.result?.ok !== true) {
    throw peerErrorOf(record.result?.error, method)
  }
  return record.result.value
}

/**
 * Classify one wire error into the closed peer reason.
 * @param error - the envelope's error diagnostic, when present.
 * @param method - the called method, for the fallback reason.
 * @returns the matching {@link PeerError}, or a generic rejection for the method family.
 */
function peerErrorOf(error: unknown, method: string): PeerError {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; details?: { reason?: unknown }; message?: unknown }
    if (record.code === 'peer-failed' && typeof record.details?.reason === 'string'
      && /^([A-Z_]+)$/.test(record.details.reason)) {
      return new PeerError(record.details.reason as PeerErrorReason)
    }
    if (typeof record.message === 'string') {
      const match = /^peer: ([A-Z_]+)/.exec(record.message)
      if (match !== null) return new PeerError(match[1] as PeerErrorReason)
    }
  }
  return method === 'hello' ? new PeerError('HELLO_REJECTED') : new PeerError('TRANSPORT_FAILED', 'call rejected')
}

/**
 * Run the challenge/hello proof exchange against one paired target.
 * @param access - the target's Grant-backed transport.
 * @param origin - exact target origin.
 * @param identity - the initiator's self-asserted identity.
 * @param key - the initiator's signing identity.
 * @returns the target's validated readback.
 */
export async function provenHello(
  access: GrantAccess,
  origin: string,
  identity: Record<string, string>,
  key: PeerKeyMaterial,
): Promise<unknown> {
  const { challenge } = await callPeerRemote(access, origin, 'challenge', {}) as { challenge: string }
  return await callPeerRemote(access, origin, 'hello', { request: {
    challenge,
    identity,
    proof: { publicKey: key.publicKey, signature: await key.signChallenge(peerHelloMessage(identity.instanceId as string, challenge)) },
  } })
}

/**
 * Validate one run-result readback value.
 * @param value - untrusted wire value.
 * @returns the validated run result.
 * @throws a {@link PeerError} with `TRANSPORT_FAILED` for malformed readbacks.
 */
export function validateRunResult(value: unknown): PeerRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('TRANSPORT_FAILED', 'malformed run result')
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0 || record.sessionId.length > 80
    || typeof record.messageId !== 'string' || record.messageId.length === 0
    || (record.state !== 'settled' && record.state !== 'running')) {
    throw new PeerError('TRANSPORT_FAILED', 'malformed run result')
  }
  if ((record.reply !== undefined && typeof record.reply !== 'string')
    || (record.endReason !== undefined && typeof record.endReason !== 'string')) {
    throw new PeerError('TRANSPORT_FAILED', 'malformed run result')
  }
  return value as unknown as PeerRunResult
}

/**
 * Validate one sessions readback value.
 * @param value - untrusted wire value.
 * @returns the validated summaries.
 * @throws a {@link PeerError} with `TRANSPORT_FAILED` for malformed readbacks.
 */
export function validateSessionSummaries(value: unknown): PeerSessionSummary[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray((value as { sessions?: unknown }).sessions)) {
    throw new PeerError('TRANSPORT_FAILED', 'malformed sessions result')
  }
  for (const entry of (value as { sessions: unknown[] }).sessions) {
    const record = entry as Record<string, unknown>
    if (typeof record.sessionId !== 'string' || typeof record.createdAt !== 'string' || typeof record.lastActivityAt !== 'string'
      || typeof record.label !== 'string' || (record.state !== 'running' && record.state !== 'idle' && record.state !== 'ended')) {
      throw new PeerError('TRANSPORT_FAILED', 'malformed sessions result')
    }
  }
  return (value as { sessions: PeerSessionSummary[] }).sessions
}

/**
 * Start one delegated session on a paired target and await its first settlement.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @param prompt - initial user prompt.
 * @param extras - optional working directory, agent profile, and settlement budget.
 * @returns the run result naming the minted session.
 */
export async function runPeerDelegate(
  options: PeerCallOptions,
  identity: PeerCallIdentity,
  prompt: string,
  extras: { cwd?: string; profile?: string; timeoutMs?: number } = {},
): Promise<PeerRunResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'delegate', { request: { proof, prompt,
    ...extras.cwd === undefined ? {} : { cwd: extras.cwd },
    ...extras.profile === undefined ? {} : { profile: extras.profile },
    ...extras.timeoutMs === undefined ? {} : { timeoutMs: extras.timeoutMs } } })
  return validateRunResult(value)
}

/**
 * Deliver the next turn into one session the initiator owns on the target.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @param sessionId - the initiator's own delegated session.
 * @param prompt - user prompt for the next turn.
 * @param timeoutMs - optional settlement budget.
 * @returns the run result of the delivered turn.
 */
export async function runPeerFollowup(
  options: PeerCallOptions,
  identity: PeerCallIdentity,
  sessionId: string,
  prompt: string,
  timeoutMs?: number,
): Promise<PeerRunResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'followup', { request: { proof, sessionId, prompt,
    ...timeoutMs === undefined ? {} : { timeoutMs } } })
  return validateRunResult(value)
}

/**
 * Read one owned turn's settlement on a paired target without a new prompt.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @param sessionId - the initiator's own delegated session.
 * @param messageId - the accepted turn whose settlement is read.
 * @returns the observed run result.
 */
export async function runPeerResult(
  options: PeerCallOptions,
  identity: PeerCallIdentity,
  sessionId: string,
  messageId: string,
): Promise<PeerRunResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'result', { request: { proof, sessionId, messageId } })
  return validateRunResult(value)
}

/**
 * Enumerate the initiator's own delegated sessions on a paired target.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @returns the caller's session summaries, newest activity first.
 */
export async function runPeerSessions(options: PeerCallOptions, identity: PeerCallIdentity): Promise<PeerSessionSummary[]> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'sessions', { request: { proof } })
  return validateSessionSummaries(value)
}

/**
 * Cancel the current turn of one session the initiator owns on a paired target.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @param sessionId - the initiator's own delegated session.
 * @returns the cancelled turn's terminal state.
 */
export async function runPeerCancel(options: PeerCallOptions, identity: PeerCallIdentity, sessionId: string): Promise<PeerRunResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'cancel', { request: { proof, sessionId } })
  return validateRunResult(value)
}

/**
 * Request one surface change on a paired target.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @param surface - complete desired surface; a pure narrowing commits immediately, any widening awaits owner approval.
 * @returns the surface in force and whether the desire is pending owner approval.
 */
export async function runPeerSurface(
  options: PeerCallOptions,
  identity: PeerCallIdentity,
  surface: PeerSurface,
): Promise<PeerSurfaceResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'surface', { request: { proof, surface } })
  return validateSurfaceResult(value)
}

/**
 * Mint one single-use event-stream token on a paired target.
 * @param options - target, home, origin, and limits.
 * @param identity - the initiator's resolved call identity.
 * @returns the stream token and the heartbeat cadence.
 */
export async function runPeerSubscribe(options: PeerCallOptions, identity: PeerCallIdentity): Promise<PeerSubscribeResult> {
  const access = accessFor(options, identity.key)
  const proof = await requestProofFor(identity)
  const value = await callPeerRemote(access, options.origin, 'subscribe', { request: { proof } })
  return validateSubscribeResult(value)
}

/** Inputs of one event-stream run; the caller owns transport establishment. */
export interface PeerStreamOptions {
  /** The paired target record carrying the Grant identity and TLS pin. */
  target: PeerTarget
  /** Absolute initiator Harness home holding the identity key. */
  home: string
  /** Origin the target endpoint resolves to for this run. */
  origin: string
  /** Fetch implementation bound to the transport; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Abort ending the stream; the returned promise then resolves. */
  signal: AbortSignal
}

/**
 * Read one subscribed event stream until it ends or aborts. Frames are wake-up
 * signals only; settlements are confirmed through `peer/result`.
 * @param options - target, origin, fetch, and abort.
 * @param streamToken - the single-use token minted by `runPeerSubscribe`.
 * @param onFrame - sink for every validated push frame.
 * @throws a {@link PeerError} with `TRANSPORT_FAILED` for a refused stream or malformed frames.
 */
export async function openPeerEventStream(
  options: PeerStreamOptions,
  streamToken: string,
  onFrame: (frame: PeerEventFrame) => void,
): Promise<void> {
  const fetchImpl = pinnedFetchFor(options.target.tlsFingerprint, options.origin, options.fetch)
  let response: Response
  try {
    response = await fetchImpl(`${options.origin}/api/peer/events?token=${encodeURIComponent(streamToken)}`, {
      signal: options.signal,
      headers: { accept: 'text/event-stream' },
    })
  } catch (error) {
    if (options.signal.aborted) return
    throw new PeerError('TRANSPORT_FAILED', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok || response.body === null) {
    throw new PeerError('TRANSPORT_FAILED', `event stream HTTP ${String(response.status)}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        const line = chunk.split('\n').find(candidate => candidate.startsWith('data: '))
        if (line === undefined) continue
        onFrame(parsePeerEventFrame(line.slice('data: '.length)))
      }
    }
  } catch (error) {
    if (options.signal.aborted) {
      try {
        await reader.cancel()
      } catch {
        // The abort already tore the stream down; cancelling a dead reader has no one left to tell.
      }
      return
    }
    throw error
  }
}

/**
 * Validate one subscribe readback value.
 * @param value - untrusted wire value.
 * @returns the validated subscribe result.
 * @throws a {@link PeerError} with `TRANSPORT_FAILED` for malformed readbacks.
 */
/** Validate one surface-change response from the wire.
 * @param value - untrusted wire value.
 * @returns the validated surface outcome.
 */
function validateSurfaceResult(value: unknown): PeerSurfaceResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (typeof record.pending !== 'boolean') throw new PeerError('INVALID_PAYLOAD')
  const surface = record.surface
  if (typeof surface !== 'object' || surface === null || Array.isArray(surface)
    || typeof (surface as Record<string, unknown>).delegate !== 'boolean'
    || typeof (surface as Record<string, unknown>).message !== 'boolean'
    || typeof (surface as Record<string, unknown>).list !== 'boolean') {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return { surface: surface as PeerSurface, pending: record.pending }
}

function validateSubscribeResult(value: unknown): PeerSubscribeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('TRANSPORT_FAILED', 'malformed subscribe result')
  const record = value as Record<string, unknown>
  if (typeof record.streamToken !== 'string' || record.streamToken.length === 0 || record.streamToken.length > 128
    || typeof record.heartbeatMs !== 'number' || !Number.isFinite(record.heartbeatMs) || record.heartbeatMs < 1) {
    throw new PeerError('TRANSPORT_FAILED', 'malformed subscribe result')
  }
  return value as PeerSubscribeResult
}

/**
 * Parse and validate one event-stream `data:` payload.
 * @param line - the raw JSON text after the `data:` prefix.
 * @returns the validated frame.
 * @throws a {@link PeerError} with `TRANSPORT_FAILED` for malformed frames.
 */
export function parsePeerEventFrame(line: string): PeerEventFrame {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new PeerError('TRANSPORT_FAILED', 'malformed event frame')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('TRANSPORT_FAILED', 'malformed event frame')
  const record = value as Record<string, unknown>
  if (record.kind !== 'settled' || typeof record.sessionId !== 'string' || record.sessionId.length === 0 || record.sessionId.length > 80) {
    throw new PeerError('TRANSPORT_FAILED', 'malformed event frame')
  }
  return record as PeerEventFrame
}

/** Wrap one fetch with a per-call timeout.
 * @param fetchImpl - transport fetch.
 * @param timeoutMs - per-call timeout.
 * @returns the wrapped fetch.
 */
function bounded(fetchImpl: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => fetchImpl(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  })
}
