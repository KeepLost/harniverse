/** Host BFF policy for resolving Remote Agent and Session identities. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { paginateSessionHistory } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHistoryPageRequest } from '@deepseek-ai/dsh-session-persistence'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'

/** Caller-facing failures preserved by the Gateway's RPC adapter. */
export type ApiRemoteLookupError =
  | { readonly code: 'agent-busy'; readonly message: string; readonly details: { readonly reason: string } }
  | { readonly code: 'session-not-found'; readonly message: string; readonly details: { readonly sessionId: SessionId } }
  | { readonly code: 'internal'; readonly message: string; readonly details: Record<never, never> }

/** Result of resolving one session identity to its live Agent. */
export type ApiRemoteAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiRemoteLookupError }

/** Resume configuration supplied by the owning Host composition. */
export interface ApiRemoteAgentOptions {
  /** Read the per-Agent defaults when a cold identity must resume. */
  readonly agentOptions?: () => AgentOptions
  /**
   * Build the Host-specific Agent-scope composition completed before
   * publication. Keyed by the resumed session's header because what a Host
   * installs may depend on what that session recorded: an agent preset fixes
   * the tools its history was produced under, so rebuilding it under another
   * composition would replay tool calls the agent can no longer make. The
   * recorded profile is an immutable header field, so the log stays unread
   * here — the resume loads it once, and reading it twice on the same
   * per-session chain would delay the caller's own history page.
   * @param session - the resumed session's persisted header.
   * @returns the Agent-scope setup to run before publication.
   */
  readonly setup?: (session: { meta: SessionHeader }) => AgentSetup | Promise<AgentSetup>
}

/** Cold identity absent from the durable session store. */
export class ApiRemoteSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiRemoteSubagentSessionOwnership extends Error {
  /**
   * Construct the ownership fence.
   * @param sessionId - identity reserved to subagent routing.
   */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/**
 * Test whether generic Host routing must leave an identity to subagent routing.
 * @param ctx - Host Context carrying the live Agent registry.
 * @param session - attached or live Session metadata.
 * @param agent - live Agent when one is registered.
 * @returns whether generic Remote and legacy API calls must reject the identity.
 */
export function hasApiRemoteSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing ownership rejection.
 * @param sessionId - identity reserved to subagent routing.
 * @returns the existing `agent-busy` RPC shape.
 */
export function apiRemoteSubagentOwnershipError(sessionId: SessionId): ApiRemoteLookupError {
  return {
    code: 'agent-busy',
    message: `session "${sessionId}" is owned by subagent routing`,
    details: { reason: 'use subagent delivery for this child session' },
  }
}

/**
 * Read one cold served session's immutable header without loading its log.
 *
 * The pre-resume decisions — subagent ownership and the recorded profile —
 * are header facts, and the resume that follows loads the log itself. Reading
 * the whole log here would pay for it twice on the same per-session
 * persistence chain, so a first click on a long session queues its own
 * history page behind a full second read.
 * @param ctx - Host Context carrying the optional persistence provider.
 * @param sessionId - durable identity to read.
 * @returns the servable session's header.
 * @throws {@link ApiRemoteSessionNotFound} when the identity has no project-backed session.
 */
export async function readApiRemoteSessionHeader(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionHeader> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
  }
  const meta = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
  if (meta === undefined || meta.cwd === undefined) {
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  return meta
}

/**
 * Inspect one cold served session without repairing, resuming, or publishing it.
 * @param ctx - Host Context carrying the optional persistence provider.
 * @param sessionId - durable identity to inspect.
 * @returns detached metadata and events for a servable session.
 * @throws {@link ApiRemoteSessionNotFound} when the identity has no project-backed session.
 */
export async function inspectApiRemoteSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
  }
  const meta = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
  if (meta === undefined || meta.cwd === undefined) {
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  const inspected = await persistence.inspect(sessionId, signal)
  if (inspected.meta.cwd === undefined) {
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  return { meta: inspected.meta, events: [...inspected.events] }
}

/**
 * Read one backward display page without resuming or fully inspecting a cold
 * session. The persistence seam may use a native tail reader; its fallback
 * retains the complete-inspection behavior for third-party backends.
 * @param ctx - Host Context carrying the persistence provider.
 * @param sessionId - durable identity to read.
 * @param request - exclusive upper bound and message quota.
 * @returns detached metadata and a contiguous raw-event page.
 * @throws {@link ApiRemoteSessionNotFound} when the identity is absent or not project-backed.
 */
export async function readApiRemoteSessionHistoryPage(
  ctx: Context,
  sessionId: SessionId,
  request: SessionHistoryPageRequest,
  signal?: AbortSignal,
): Promise<{ meta: SessionHeader; events: SessionEvent[]; hasMore: boolean }> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
  }
  const meta = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
  if (meta === undefined || meta.cwd === undefined) {
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  if (typeof persistence.readHistoryPage === 'function') {
    const page = await persistence.readHistoryPage(sessionId, request, signal)
    if (page.meta.cwd === undefined) {
      throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
    }
    return { meta: page.meta, events: page.events, hasMore: page.hasMore }
  }
  const inspected = await persistence.inspect(sessionId, signal)
  if (inspected.meta.cwd === undefined) {
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  const page = paginateSessionHistory(inspected.events, request)
  return { meta: inspected.meta, events: page.events, hasMore: page.hasMore }
}

/**
 * Create the Host's shared Agent resolver and configure Agent/Session Typert lookups.
 * Live Agents are reused, ordinary cold sessions resume once per identity, and
 * subagent-owned identities retain the legacy `agent-busy` fence.
 * @param ctx - owning Host Context.
 * @param options - defaults and Agent-scope setup used only for cold resume.
 * @returns resolver shared by legacy API Proxy methods and Typert lookups.
 */
export function createApiRemoteAgentResolver(
  ctx: Context,
  options: ApiRemoteAgentOptions,
): (sessionId: SessionId) => Promise<ApiRemoteAgentResult> {
  const resumes = new Map<SessionId, Promise<Agent>>()

  const fencedLiveAgent = (sessionId: SessionId): ApiRemoteAgentResult | undefined => {
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return undefined
    if (hasApiRemoteSubagentOwner(ctx, live.session, live)) {
      return { error: apiRemoteSubagentOwnershipError(sessionId) }
    }
    return { agent: live }
  }

  const agentFor = async (sessionId: SessionId): Promise<ApiRemoteAgentResult> => {
    const fenced = fencedLiveAgent(sessionId)
    if (fenced !== undefined) return fenced
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiRemoteSubagentOwner(ctx, attached, undefined)) {
      return { error: apiRemoteSubagentOwnershipError(sessionId) }
    }
    let resume = resumes.get(sessionId)
    if (resume === undefined) {
      resume = (async () => {
        try {
          const meta = await readApiRemoteSessionHeader(ctx, sessionId)
          if (hasApiRemoteSubagentOwner(ctx, { header: meta }, undefined)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          // Built from the read header before the published re-checks below, so
          // those stay adjacent to `resume` and a Host setup that awaits
          // (composing a preset, say) does not widen the collision window.
          const setup = options.setup === undefined ? undefined : await options.setup({ meta })
          const publishedSession = ctx.sessions.get(sessionId)
          const publishedAgent = ctx.agents.get(sessionId)
          if (publishedSession !== undefined
            && hasApiRemoteSubagentOwner(ctx, publishedSession, publishedAgent)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions() },
            ...setup === undefined ? {} : { setup },
          })
          // The resume's own load is the authoritative read of the stored
          // header, so a project-less identity is rejected against it rather
          // than through a second full read before resuming. The listing is
          // only a directory: it may name a session the log itself does not
          // place in a project, and such an identity is not servable.
          if (handle.agent.session.header.cwd === undefined) {
            await handle.dispose()
            throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
          }
          return handle.agent
        } finally {
          resumes.delete(sessionId)
        }
      })()
      resumes.set(sessionId, resume)
    }
    try {
      return { agent: await resume }
    } catch (error: unknown) {
      if (error instanceof ApiRemoteSessionNotFound) {
        return { error: { code: 'session-not-found', message: error.message, details: { sessionId } } }
      }
      if (error instanceof ApiRemoteSubagentSessionOwnership) {
        return { error: apiRemoteSubagentOwnershipError(error.sessionId) }
      }
      const fenced = fencedLiveAgent(sessionId)
      if (fenced !== undefined) return fenced
      const attached = ctx.sessions.get(sessionId)
      if (attached !== undefined && hasApiRemoteSubagentOwner(ctx, attached, undefined)) {
        return { error: apiRemoteSubagentOwnershipError(sessionId) }
      }
      return {
        error: {
          code: 'internal',
          message: `resume failed for session "${sessionId}": ${String(error)}`,
          details: {},
        },
      }
    }
  }

  ctx.inject(['typert'], (typeCtx) => {
    const resolveAgent = async (sessionId: SessionId): Promise<Agent> => {
      const found = await agentFor(sessionId)
      if ('error' in found) throw new TypertLookupFailure(found.error)
      return found.agent
    }
    typeCtx.typert.lookups.configure('agent', resolveAgent)
    typeCtx.typert.lookups.configure('session', async sessionId => (await resolveAgent(sessionId)).session)
    typeCtx.typert.contexts.configureHost('agent', async sessionId => (await resolveAgent(sessionId)).ctx)
  })

  return agentFor
}
