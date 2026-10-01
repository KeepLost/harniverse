/**
 * Client Agent-scope primitive: mint a Cordis context tagged with the owning
 * Agent's identity. The mechanism mirrors the host `dsh-scope` architecture
 * (no-op plugin fiber + context tag + `Context.filter` routing predicate);
 * the shape deliberately diverges: the filter lives on the actx itself
 * instead of a separate carrier object, so scoped dispatch is plain cordis —
 * `actx.bail(actx, event, payload)` / `actx.emit(actx, ...)` — with no
 * wrapper. The host needs a detached carrier because its dispatch subject is
 * the business Agent object; client scope events carry only ids, so the
 * actx is the natural subject. The second divergence stands: the scope key
 * is the branded `SessionId` (value compared), not an object identity — the
 * agent and its session share one id (1:1, same axis; no separate AgentId
 * brand). A local incarnation distinguishes equal ids on different machines. Third divergence,
 * deliberate: the client scopes the Agent IDENTITY, not a live Agent object
 * — a cold session's host Agent is already disposed while its client actx
 * stays alive for history viewing.
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber, FiberState as FiberStateEnum } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote, TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Runtime mirror of Cordis's `FiberState` const enum members used here. A const
 * enum carries no runtime object to import (bundlers erase `export *` of it), so
 * the values mirror the pinned vendored definition while retaining its types —
 * the same pattern as `@deepseek-ai/dsh-tool-cordis/fiber-state`.
 */
const FiberState = {
  PENDING: 0 as FiberStateEnum.PENDING,
  LOADING: 1 as FiberStateEnum.LOADING,
  ACTIVE: 2 as FiberStateEnum.ACTIVE,
  FAILED: 3 as FiberStateEnum.FAILED,
  DISPOSED: 4 as FiberStateEnum.DISPOSED,
  UNLOADING: 5 as FiberStateEnum.UNLOADING,
} as const

/** Client Cordis Context carrying one Agent identity and its scoped Remote namespaces. */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: TypertClientRemote & TypertRemoteScopeApi<'agent'>
}

/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope')
const kIncarnation = Symbol('dsh.client.scope.incarnation')

/** A minted Agent scope and its disposal boundary. */
export interface AgentScopeHandle {
  /**
   * Tagged context: scope-owned registrations and scoped dispatch both go
   * through it (passing it as the dispatch subject routes to this agent's
   * tagged listeners plus every untagged one).
   */
  ctx: AgentContext
  /** Backing fiber (dispose tears down every scope-owned registration). */
  fiber: Fiber
}

/** Shared no-op plugin backing each Agent scope fiber. */
function agentScope(): void {}

/**
 * Mint an Agent scope under `ctx`: a no-op plugin fiber whose context
 * carries the agent tag and the dispatch filter — untagged listeners are
 * admitted globally, tagged listeners only for a matching agent.
 * Registrations through the returned ctx dispose with the fiber.
 * @param ctx - client root context the scope fiber mounts under.
 * @param key - owning agent identity (the routing tag; agent id === session id).
 * @returns the tagged context and its backing fiber.
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const scoped = fiber.ctx.extend({
    [kScope]: key,
    [kIncarnation]: {},
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeOf(listenerCtx)
      return fiber.uid !== null && fiber.state !== FiberState.UNLOADING
        && (tag === undefined || (tag === key && sameScope(listenerCtx, scoped)))
    },
  }) as AgentContext
  return {
    fiber,
    ctx: scoped,
  }
}

/**
 * Read the nearest agent tag inherited by a context.
 * @param ctx - any client context.
 * @returns its agent identity (the session id), or undefined for root contexts.
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return (ctx as Context & { [kScope]?: SessionId })[kScope]
}

/** Compare inherited scope incarnations, including contexts extended by consumers.
 * @param left - the context being addressed.
 * @param right - the incumbent scope context of the same session id.
 * @returns whether both carry the same scope incarnation.
 */
export function sameScope(left: Context, right: Context | undefined): boolean {
  const identity = (ctx: Context): object | undefined => (ctx as Context & { [kIncarnation]?: object })[kIncarnation]
  return right !== undefined && identity(left) === identity(right)
}
