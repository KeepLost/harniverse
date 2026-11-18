/** Peer delegation operations: peer-owned sessions, turn delivery, and settlement observation. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve as resolvePath, sep, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-model-policy'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type {
  PeerDelegateRequest,
  PeerFollowupRequest,
  PeerInstanceId,
  PeerRequestProof,
  PeerRunResult,
  PeerSessionState,
  PeerSessionSummary,
} from '@deepseek-ai/dsh-peer-protocol'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PeerSessionEntry } from './session-registry.ts'
import { findPeerSession, readPeerSessions, writePeerSessions } from './session-registry.ts'

/** Settlement-wait budget applied when a request names none. */
export const PEER_RUN_TIMEOUT_DEFAULT_MS = 600_000

/** Ceiling for a request-named settlement-wait budget. */
export const PEER_RUN_TIMEOUT_MAX_MS = 900_000

/** Upper bound on one delivered prompt's length in UTF-16 code units. */
const PEER_PROMPT_MAX_LENGTH = 32_768

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
  return value as unknown as PeerDelegateRequest
}

/**
 * Validate one follow-up request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
export function validateFollowupRequest(value: unknown): PeerFollowupRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (typeof record.proof !== 'object' || record.proof === null || Array.isArray(record.proof)) throw new PeerError('INVALID_PAYLOAD')
  if (typeof record.sessionId !== 'string' || !PEER_SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new PeerError('INVALID_PAYLOAD', 'sessionId out of range')
  }
  if (typeof record.prompt !== 'string' || record.prompt.length === 0 || record.prompt.length > PEER_PROMPT_MAX_LENGTH) {
    throw new PeerError('INVALID_PAYLOAD', 'prompt out of range')
  }
  effectiveTimeout(record.timeoutMs as number | undefined)
  return value as unknown as PeerFollowupRequest
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

/** Deliver one prompt as the session's next FIFO turn and observe its settlement.
 * @param ctx - host context.
 * @param sessionId - the caller's own session.
 * @param agent - the session's live agent.
 * @param prompt - user prompt text.
 * @param timeoutMs - settlement-wait budget.
 * @returns the run result naming the accepted message.
 * @throws a {@link PeerError} with `SESSION_BUSY` when the agent rejects delivery.
 */
async function deliverTurn(ctx: Context, sessionId: string, agent: Agent, prompt: string, timeoutMs: number): Promise<PeerRunResult> {
  void ctx
  const baseline = agent.session.seq
  const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
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
  const result = await deliverTurn(ctx, sessionId, handle.agent, request.prompt, effectiveTimeout(request.timeoutMs))
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
  const sessions = await readPeerSessions(home)
  const entry = findPeerSession(sessions, request.sessionId)
  if (entry === undefined || entry.peerInstanceId !== instanceId) throw new PeerError('SESSION_NOT_FOUND')
  const agent = await ensurePeerAgent(ctx, entry)
  const result = await deliverTurn(ctx, entry.sessionId, agent, request.prompt, effectiveTimeout(request.timeoutMs))
  await writePeerSessions(home, sessions
    .map(item => item.sessionId === entry.sessionId ? { ...item, lastActivityAt: new Date().toISOString() } : item))
  return result
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
