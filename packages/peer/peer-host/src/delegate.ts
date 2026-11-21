/** Peer delegation operations: peer-owned sessions, turn delivery, and settlement observation. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve as resolvePath, sep, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentError, fileHandleText } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-model-policy'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type {
  PeerCancelRequest,
  PeerDelegateRequest,
  PeerDownloadRequest,
  PeerDownloadResult,
  PeerFollowupRequest,
  PeerInstanceId,
  PeerRequestProof,
  PeerResultRequest,
  PeerRunResult,
  PeerSessionState,
  PeerSessionSummary,
  PeerUploadRef,
} from '@deepseek-ai/dsh-peer-protocol'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { PeerSessionEntry } from './session-registry.ts'
import { findPeerSession, readPeerSessions, writePeerSessions } from './session-registry.ts'
import { authorizePeerTurn, recordPeerTurn } from './governance.ts'
import { takeStagedUpload } from './staging.ts'

/** Settlement-wait budget applied when a request names none. */
export const PEER_RUN_TIMEOUT_DEFAULT_MS = 600_000

/** Ceiling for a request-named settlement-wait budget. */
export const PEER_RUN_TIMEOUT_MAX_MS = 900_000

/** Upper bound on one delivered prompt's length in UTF-16 code units. */
const PEER_PROMPT_MAX_LENGTH = 32_768

/** Upper bound on staged uploads one delivered message may admit. */
const PEER_UPLOADS_PER_TURN_MAX = 4

/** Upper bound on one workspace file a `peer/download` call returns in a single frame. */
export const PEER_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024

/** Session-id shape minted for delegated sessions. */
const PEER_SESSION_ID_PATTERN = /^peer-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One unref'd timeout that cannot keep a process alive awaiting settlement.
 * @param ms - delay in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
}

/** Bound one request-named timeout to the allowed range.
 * @param timeoutMs - request value, if any.
 * @returns the effective budget.
 */
function effectiveTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return PEER_RUN_TIMEOUT_DEFAULT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > PEER_RUN_TIMEOUT_MAX_MS) {
    throw new PeerError('INVALID_PAYLOAD', 'timeoutMs out of range')
  }
  return timeoutMs
}

/** Validate one staged-upload reference list's shape.
 * @param value - untrusted wire value.
 * @returns the validated references.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed references.
 */
function validateUploadRefs(value: unknown): PeerUploadRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PEER_UPLOADS_PER_TURN_MAX) {
    throw new PeerError('INVALID_PAYLOAD', 'uploads out of range')
  }
  const refs: PeerUploadRef[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new PeerError('INVALID_PAYLOAD', 'upload reference is not an object')
    const record = entry as Record<string, unknown>
    if (Object.keys(record).length !== 2 || typeof record.uploadId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.uploadId)
      || typeof record.sha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.sha256)) {
      throw new PeerError('INVALID_PAYLOAD', 'upload reference fields')
    }
    refs.push(entry as PeerUploadRef)
  }
  return refs
}

/**
 * Validate one delegate request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateDelegateRequest(value: unknown): PeerDelegateRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (typeof record.proof !== 'object' || record.proof === null || Array.isArray(record.proof)) throw new PeerError('INVALID_PAYLOAD')
  if (typeof record.prompt !== 'string' || record.prompt.length === 0 || record.prompt.length > PEER_PROMPT_MAX_LENGTH) {
    throw new PeerError('INVALID_PAYLOAD', 'prompt out of range')
  }
  if (record.cwd !== undefined && (typeof record.cwd !== 'string' || record.cwd.length === 0 || record.cwd.length > 256
    || record.cwd.includes('\0') || isAbsolute(record.cwd))) {
    throw new PeerError('INVALID_PAYLOAD', 'cwd must be a relative path')
  }
  if (record.profile !== undefined && (typeof record.profile !== 'string' || record.profile.length === 0 || record.profile.length > 128)) {
    throw new PeerError('INVALID_PAYLOAD', 'profile out of range')
  }
  effectiveTimeout(record.timeoutMs as number | undefined)
  if (record.uploads !== undefined) validateUploadRefs(record.uploads)
  return value as unknown as PeerDelegateRequest
}

/**
 * Validate one follow-up request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateFollowupRequest(value: unknown): PeerFollowupRequest {
  const record = requireSessionEnvelope(value)
  if (typeof record.prompt !== 'string' || record.prompt.length === 0 || record.prompt.length > PEER_PROMPT_MAX_LENGTH) {
    throw new PeerError('INVALID_PAYLOAD', 'prompt out of range')
  }
  effectiveTimeout(record.timeoutMs as number | undefined)
  if (record.uploads !== undefined) validateUploadRefs(record.uploads)
  return value as PeerFollowupRequest
}

/** Validate the shared proof-plus-session prefix of one session-addressed request.
 * @param value - untrusted wire value.
 * @returns the envelope record with proof and session id validated.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed envelopes.
 */
function requireSessionEnvelope(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (typeof record.proof !== 'object' || record.proof === null || Array.isArray(record.proof)) throw new PeerError('INVALID_PAYLOAD')
  if (typeof record.sessionId !== 'string' || !PEER_SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new PeerError('INVALID_PAYLOAD', 'sessionId out of range')
  }
  return record
}

/**
 * Validate one settlement-read request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateResultRequest(value: unknown): PeerResultRequest {
  const record = requireSessionEnvelope(value)
  if (typeof record.messageId !== 'string' || record.messageId.length === 0 || record.messageId.length > 128) {
    throw new PeerError('INVALID_PAYLOAD', 'messageId out of range')
  }
  return value as PeerResultRequest
}

/**
 * Validate one cancellation request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateCancelRequest(value: unknown): PeerCancelRequest {
  requireSessionEnvelope(value)
  return value as PeerCancelRequest
}

/**
 * Validate one subscription request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateSubscribeRequest(value: unknown): { proof: PeerRequestProof } {
  return validateSessionsRequest(value)
}

/**
 * Validate one sessions-enumeration request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 */
export function validateSessionsRequest(value: unknown): { proof: PeerRequestProof } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>).proof !== 'object' || (value as Record<string, unknown>).proof === null) {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return value as { proof: PeerRequestProof }
}

/**
 * Resolve the caller's session-root directory under one home.
 * @param home - absolute Harness home directory.
 * @param instanceId - the caller's pinned identity.
 * @returns the absolute peer root.
 */
export function peerSessionRoot(home: string, instanceId: PeerInstanceId): string {
  return join(home, 'peer-work', instanceId)
}

/**
 * Resolve one delegated working directory inside the caller's root.
 * @param home - absolute Harness home directory.
 * @param instanceId - the caller's pinned identity.
 * @param relative - request-named relative path; absent means the root itself.
 * @returns the absolute working directory.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for absolute or escaping paths.
 */
export function resolvePeerCwd(home: string, instanceId: PeerInstanceId, relative: string | undefined): string {
  const root = peerSessionRoot(home, instanceId)
  if (relative === undefined) return root
  const resolved = resolvePath(root, relative)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new PeerError('INVALID_PAYLOAD', 'cwd escapes the peer root')
  return resolved
}

/** Derive one entry's creation label from its initial prompt.
 * @param prompt - the delivered initial prompt.
 * @returns the first line truncated to 64 characters.
 */
function labelOf(prompt: string): string {
  /* v8 ignore next -- split always yields one element; the fallback names the impossible */
  const firstLine = prompt.split('\n', 1)[0] ?? ''
  return firstLine.length <= 64 ? firstLine : firstLine.slice(0, 64)
}

/** Compose one delegated session's agent setup, mirroring the API proxy's default composition.
 * @param ctx - host context.
 * @param profile - request-named agent profile id, if any.
 * @returns the resolved profile id and the agent-scoped setup.
 */
/** Composition result of {@link composePeerAgent}. */
interface PeerAgentComposition {
  agentProfile?: string
  setup: (agentCtx: Context) => Promise<void>
}

async function composePeerAgent(ctx: Context, profile: string | undefined): Promise<PeerAgentComposition> {
  const presets = ctx.get('agentPresets')
  const modelPolicy = () => ctx.get('modelPolicy')
  if (presets === undefined) {
    return {
      setup: (agentCtx: Context) => {
        const agent = agentCtx.agent
        if (agent !== undefined) modelPolicy()?.initialize(agent.session)
        return Promise.resolve()
      },
    }
  }
  const resolved = await presets.resolve(profile).catch(() => {
    throw new PeerError('INVALID_PAYLOAD', 'profile cannot be resolved')
  })
  return {
    agentProfile: resolved.id,
    setup: async (agentCtx) => {
      const agent = agentCtx.agent
      if (agent !== undefined) modelPolicy()?.initialize(agent.session)
      await presets.mount(agentCtx, resolved.id)
    },
  }
}

/** Resolve the agent registry without a hard inject, mirroring optional-service access.
 * @param ctx - host context.
 * @returns the registry.
 * @throws a {@link PeerError} with `SESSION_BUSY` when the composition ships no agent registry.
 */
function agentsOf(ctx: Context): AgentRegistry {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new PeerError('SESSION_BUSY', 'agents unavailable')
  return agents
}

/** Resolve the deployment's default agent options, when a default selection exists.
 * @param ctx - host context.
 * @returns the default provider and model, or `undefined` to take the loop's own default.
 */
function defaultAgentOptions(ctx: Context): AgentOptions | undefined {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) return undefined
  const { provider, model } = defaults.currentSelection()
  return { provider, model }
}

/** Derive one delivered prompt's settlement from the session's appended event window.
 * @param events - events appended since before the prompt's delivery.
 * @param messageId - the accepted prompt's message id.
 * @returns the terminal state, reply, and end reason; `undefined` while the turn is still outstanding.
 */
function settlementOf(events: readonly SessionEvent[], messageId: string): Omit<PeerRunResult, 'sessionId' | 'messageId'> | undefined {
  const claimIndex = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
  if (claimIndex < 0) return undefined
  const end = events.slice(claimIndex).find(event => event.type === 'turn/end')
  if (end === undefined) return undefined
  let reply = ''
  for (const event of events.slice(claimIndex)) {
    if (event.type !== 'assistant/message' || event.data.turn !== end.data.turn) continue
    for (const block of event.data.message.content) {
      if (block.type === 'text') reply += block.text
    }
  }
  return { state: 'settled', ...reply.length > 0 ? { reply } : {}, endReason: end.data.reason.kind }
}

/** Map one attachment-pipeline failure onto the closed peer artifact reasons.
 * @param error - the thrown failure from the attachment store.
 * @returns the equivalent {@link PeerError}.
 */
function attachmentFailure(error: unknown): PeerError {
  if (error instanceof AttachmentError) {
    return error.code === 'FILE_TOO_LARGE'
      ? new PeerError('ATTACHMENT_TOO_LARGE')
      : new PeerError('ATTACHMENT_REFUSED', error.code)
  }
  return new PeerError('ATTACHMENT_REFUSED', 'attachment store')
}

/** Resolve the optional attachment store, refusing artifact-bearing turns without one.
 * @param ctx - host context.
 * @returns the deployment's attachment store.
 * @throws a {@link PeerError} with `ATTACHMENT_REFUSED` when no store is composed.
 */
function attachmentsOf(ctx: Context): AttachmentStore {
  const store = ctx.get('attachments')
  if (store === undefined) throw new PeerError('ATTACHMENT_REFUSED', 'attachment store is not configured')
  return store
}

/** Consume one message's staged uploads through the deployment's attachment pipeline.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param uploads - validated upload references from the delivered message.
 * @returns durable attachment references in the message's order.
 */
async function admitUploads(
  ctx: Context,
  home: string,
  instanceId: PeerInstanceId,
  uploads: readonly PeerUploadRef[] | undefined,
): Promise<FileAttachmentRef[]> {
  if (uploads === undefined) return []
  const store = attachmentsOf(ctx)
  const refs: FileAttachmentRef[] = []
  for (const upload of uploads) {
    const staged = await takeStagedUpload(home, instanceId, upload.uploadId, upload.sha256)
    try {
      refs.push(await store.saveFile({
        data: staged.data,
        ...staged.manifest.mediaType === undefined ? {} : { mediaType: staged.manifest.mediaType },
        name: staged.manifest.name,
      }))
    } catch (error) {
      throw attachmentFailure(error)
    }
  }
  return refs
}

/** Deliver one prompt as the session's next FIFO turn and observe its settlement.
 * @param ctx - host context.
 * @param sessionId - the caller's own session.
 * @param agent - the session's live agent.
 * @param prompt - user prompt text.
 * @param timeoutMs - settlement-wait budget.
 * @param files - durable artifacts admitted with this message, in delivery order.
 * @returns the run result naming the accepted message.
 * @throws a {@link PeerError} with `SESSION_BUSY` when the agent rejects delivery.
 */
async function deliverTurn(
  ctx: Context,
  sessionId: string,
  agent: Agent,
  prompt: string,
  timeoutMs: number,
  files: readonly FileAttachmentRef[] = [],
): Promise<PeerRunResult> {
  const content = [{ type: 'text' as const, text: prompt }]
  if (files.length > 0) {
    const store = attachmentsOf(ctx)
    for (const ref of files) {
      let path: string
      try {
        path = await store.publishFileHandle(ref)
      } catch (error) {
        throw attachmentFailure(error)
      }
      content.push({ type: 'text', text: fileHandleText(ref, path) })
    }
  }
  const baseline = agent.session.seq
  const message = createUserMessage({
    content,
    source: { kind: 'user', ...files.length > 0 ? { files: [...files] } : {} },
  })
  try {
    agent.followup(message)
  } catch {
    throw new PeerError('SESSION_BUSY')
  }
  await Promise.race([agent.whenIdle(), delay(timeoutMs)])
  const settled = settlementOf(agent.session.eventsFrom(baseline), message.id)
  return { sessionId, messageId: message.id, ...settled ?? { state: 'running' } }
}

/** Ensure one registry entry has a live agent, cold-resuming its persisted session when absent.
 * @param ctx - host context.
 * @param entry - the caller's session entry.
 * @returns the live agent.
 * @throws a {@link PeerError} with `SESSION_NOT_FOUND` when the session cannot be resumed.
 */
async function ensurePeerAgent(ctx: Context, entry: PeerSessionEntry): Promise<Agent> {
  const agents = agentsOf(ctx)
  const existing = agents.get(entry.sessionId as SessionId)
  if (existing !== undefined) return existing
  const composition = await composePeerAgent(ctx, entry.profile)
  const agentOptions = defaultAgentOptions(ctx)
  try {
    return (await agents.resume({
      resumeSessionId: entry.sessionId as SessionId,
      ...agentOptions === undefined ? {} : { agentOptions },
      setup: composition.setup,
    })).agent
  } catch {
    throw new PeerError('SESSION_NOT_FOUND', 'session cannot be resumed')
  }
}

/** Start one delegated session for a verified peer and deliver its initial prompt.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified caller's identity.
 * @param request - validated delegate request.
 * @returns the run result naming the minted session.
 */
export async function delegateToPeer(
  ctx: Context,
  home: string,
  instanceId: PeerInstanceId,
  request: PeerDelegateRequest,
): Promise<PeerRunResult> {
  // The budget gate precedes session minting; a capped peer leaves no artifacts behind.
  await authorizePeerTurn(home, instanceId, new Date())
  const cwd = resolvePeerCwd(home, instanceId, request.cwd)
  const sessionId = `peer-${randomUUID()}`
  const composition = await composePeerAgent(ctx, request.profile)
  try {
    await mkdir(cwd, { recursive: true })
  } catch {
    throw new PeerError('STORE_FAILED', 'peer working directory')
  }
  let handle
  const agentOptions = defaultAgentOptions(ctx)
  try {
    handle = await agentsOf(ctx).create({
      sessionId: sessionId as SessionId,
      ...agentOptions === undefined ? {} : { agentOptions },
      meta: { cwd, origin: 'peer', ...composition.agentProfile === undefined ? {} : { agentProfile: composition.agentProfile } },
      setup: composition.setup,
    })
  } catch {
    throw new PeerError('SESSION_BUSY', 'session cannot be created')
  }
  const now = new Date().toISOString()
  const entry: PeerSessionEntry = {
    sessionId,
    peerInstanceId: instanceId,
    createdAt: now,
    lastActivityAt: now,
    cwd,
    ...request.profile === undefined ? {} : { profile: request.profile },
    label: labelOf(request.prompt),
  }
  const beforeDeliver = [...(await readPeerSessions(home)).filter(item => item.sessionId !== sessionId), entry]
  await writePeerSessions(home, beforeDeliver)
  const files = await admitUploads(ctx, home, instanceId, request.uploads)
  const result = await deliverTurn(ctx, sessionId, handle.agent, request.prompt, effectiveTimeout(request.timeoutMs), files)
  // The turn was accepted for delivery, so it consumed budget whatever its settlement says.
  await recordPeerTurn(home, instanceId, new Date())
  const afterDeliver = (await readPeerSessions(home))
    .map(item => item.sessionId === sessionId ? { ...item, lastActivityAt: new Date().toISOString() } : item)
  await writePeerSessions(home, afterDeliver)
  return result
}

/** Deliver the next turn into one session the verified caller owns.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified caller's identity.
 * @param request - validated follow-up request.
 * @returns the run result of the delivered turn.
 * @throws a {@link PeerError} with `SESSION_NOT_FOUND` when the session is not the caller's.
 */
export async function followupPeerSession(
  ctx: Context,
  home: string,
  instanceId: PeerInstanceId,
  request: PeerFollowupRequest,
): Promise<PeerRunResult> {
  // The budget gate precedes the session lookup; a capped peer learns nothing about stored ids.
  await authorizePeerTurn(home, instanceId, new Date())
  const sessions = await readPeerSessions(home)
  const entry = findPeerSession(sessions, request.sessionId)
  if (entry === undefined || entry.peerInstanceId !== instanceId) throw new PeerError('SESSION_NOT_FOUND')
  const agent = await ensurePeerAgent(ctx, entry)
  const files = await admitUploads(ctx, home, instanceId, request.uploads)
  const result = await deliverTurn(ctx, entry.sessionId, agent, request.prompt, effectiveTimeout(request.timeoutMs), files)
  // The turn was accepted for delivery, so it consumed budget whatever its settlement says.
  await recordPeerTurn(home, instanceId, new Date())
  await writePeerSessions(home, sessions
    .map(item => item.sessionId === entry.sessionId ? { ...item, lastActivityAt: new Date().toISOString() } : item))
  return result
}

/** Whether one accepted turn's claim appears in the event window.
 * @param events - events that may carry the claim.
 * @param messageId - the accepted prompt's message id.
 * @returns whether the claim is present.
 */
function claimed(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(event => event.type === 'user/message' && event.data.id === messageId)
}

/** Read one owned turn's settlement without delivering another prompt.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified caller's identity.
 * @param request - validated settlement-read request.
 * @returns the observed turn state, reply, and end reason.
 * @throws a {@link PeerError} with `SESSION_NOT_FOUND` when the session or turn cannot be observed.
 */
export async function resultPeerSession(
  ctx: Context,
  home: string,
  instanceId: PeerInstanceId,
  request: PeerResultRequest,
): Promise<PeerRunResult> {
  const entry = findPeerSession(await readPeerSessions(home), request.sessionId)
  if (entry === undefined || entry.peerInstanceId !== instanceId) throw new PeerError('SESSION_NOT_FOUND')
  const agent = ctx.get('agents')?.get(entry.sessionId as SessionId)
  if (agent !== undefined) {
    const events = agent.session.events
    if (!claimed(events, request.messageId)) {
      // The claim fell outside the resident suffix (compacted while outstanding).
      throw new PeerError('SESSION_NOT_FOUND', 'turn is no longer observable live')
    }
    const settled = settlementOf(events, request.messageId)
    return { sessionId: entry.sessionId, messageId: request.messageId, ...settled ?? { state: 'running' } }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new PeerError('SESSION_NOT_FOUND', 'session persistence is not configured')
  const inspected = await persistence.inspect(entry.sessionId as SessionId).catch(() => undefined)
  if (inspected === undefined) throw new PeerError('SESSION_NOT_FOUND')
  if (!claimed(inspected.events, request.messageId)) {
    throw new PeerError('SESSION_NOT_FOUND', 'turn is not in the persisted log')
  }
  const settled = settlementOf(inspected.events, request.messageId)
  return { sessionId: entry.sessionId, messageId: request.messageId, ...settled ?? { state: 'running' } }
}

/** Derive one entry's live state from agent residency and status.
 * @param ctx - host context.
 * @param entry - the session entry.
 * @returns the lifecycle state.
 */
function liveState(ctx: Context, entry: PeerSessionEntry): PeerSessionState {
  const agent = ctx.get('agents')?.get(entry.sessionId as SessionId)
  if (agent === undefined) return 'ended'
  return agent.status === 'running' ? 'running' : 'idle'
}

/** Derive the newest delivered prompt's message id inside the resident event window. */
function lastClaimOf(events: readonly SessionEvent[]): string | undefined {
  let last: string | undefined
  for (const event of events) {
    if (event.type === 'user/message') last = event.data.id
  }
  return last
}

/** Cancel the current turn of one session the verified caller owns.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified caller's identity.
 * @param request - validated cancellation request.
 * @returns the cancelled turn's terminal state.
 * @throws a {@link PeerError} with `SESSION_NOT_FOUND` when the session is not the caller's or holds no live agent.
 */
export async function cancelPeerSession(
  ctx: Context,
  home: string,
  instanceId: PeerInstanceId,
  request: PeerCancelRequest,
): Promise<PeerRunResult> {
  const entry = findPeerSession(await readPeerSessions(home), request.sessionId)
  if (entry === undefined || entry.peerInstanceId !== instanceId) throw new PeerError('SESSION_NOT_FOUND')
  const agent = ctx.get('agents')?.get(entry.sessionId as SessionId)
  if (agent === undefined) throw new PeerError('SESSION_NOT_FOUND', 'session is not live')
  const lastClaim = lastClaimOf(agent.session.events)
  if (lastClaim === undefined) throw new PeerError('SESSION_NOT_FOUND', 'turn is no longer observable live')
  if (agent.status === 'running') {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
  }
  const settled = settlementOf(agent.session.events, lastClaim)
  return { sessionId: entry.sessionId, messageId: lastClaim, ...settled ?? { state: 'running' } }
}

/** Enumerate the verified caller's own delegated sessions.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified caller's identity.
 * @returns the caller's session summaries, newest activity first.
 */
export async function listPeerSessions(ctx: Context, home: string, instanceId: PeerInstanceId): Promise<PeerSessionSummary[]> {
  const sessions = (await readPeerSessions(home)).filter(entry => entry.peerInstanceId === instanceId)
  return sessions
    .map(entry => ({
      sessionId: entry.sessionId, createdAt: entry.createdAt, lastActivityAt: entry.lastActivityAt,
      state: liveState(ctx, entry), label: entry.label,
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

/** Drop one peer's registry entries and close its live agents from true idle.
 * @param ctx - host context.
 * @param home - absolute Harness home directory.
 * @param instanceId - the removed peer's identity.
 */
export async function dropPeerSessions(ctx: Context, home: string, instanceId: PeerInstanceId): Promise<void> {
  const sessions = await readPeerSessions(home)
  const remaining = sessions.filter(entry => entry.peerInstanceId !== instanceId)
  if (remaining.length !== sessions.length) await writePeerSessions(home, remaining)
  const agents = ctx.get('agents')
  for (const entry of sessions) {
    if (entry.peerInstanceId !== instanceId) continue
    if (agents?.get(entry.sessionId as SessionId) !== undefined) await agents.closeIfIdle(entry.sessionId as SessionId)
  }
}

/** Read one bounded workspace file from the caller's peer root for download.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param request - validated download request.
 * @returns the file's digest-bearing single-frame readback.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for missing or unreadable files, or `ATTACHMENT_TOO_LARGE` past the frame cap.
 */
export async function downloadPeerFile(
  home: string,
  instanceId: PeerInstanceId,
  request: PeerDownloadRequest,
): Promise<PeerDownloadResult> {
  const root = peerSessionRoot(home, instanceId)
  const absolute = resolvePath(root, request.path)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new PeerError('INVALID_PAYLOAD', 'path escapes the peer root')
  }
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new PeerError('INVALID_PAYLOAD', 'file not found')
  if (info.size > PEER_DOWNLOAD_MAX_BYTES) {
    throw new PeerError('ATTACHMENT_TOO_LARGE', `frame cap ${PEER_DOWNLOAD_MAX_BYTES}`)
  }
  const data = new Uint8Array(await readFile(absolute))
  return {
    name: basename(absolute),
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('base64url'),
    dataBase64: Buffer.from(data).toString('base64'),
  }
}
