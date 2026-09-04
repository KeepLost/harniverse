/**
 * Caller identity, id-bound observation checks, and visible lineage projection.
 *
 * @module @deepseek-ai/dsh-tool-session-query/workspace-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import type {
  SessionLineageNode,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { serviceBoundary } from './service-boundary.ts'

interface Caller {
  readonly id: SessionIdValue
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
  get(id: SessionIdValue): TitleView
}

interface AuthorizedDescendant {
  readonly record: SessionRecord
  readonly descendants: AuthorizedDescendant[]
}

interface DescendantProjectionFrame {
  readonly node: SessionLineageNode
  readonly target: AuthorizedDescendant[]
  readonly next: DescendantProjectionFrame | undefined
}

interface DescendantVisit {
  readonly node: AuthorizedDescendant
  readonly depth: number
  readonly next: DescendantVisit | undefined
}

function callerOf(exec: ToolRunContext): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session query tools require an agent-bound caller',
      'SESSION_QUERY_TOOL_MISSING_AGENT',
    )
  }
  return {
    id: agent.session.id,
    header: agent.session.header,
    events: agent.session.events,
  }
}

function targetId(args: { readonly session_id?: string }, caller: Caller): SessionIdValue {
  return args.session_id === undefined ? caller.id : SessionId(args.session_id)
}

async function authorizeTarget(
  ctx: Context,
  caller: Caller,
  target: SessionIdValue,
  signal: AbortSignal,
): Promise<void> {
  if (target === caller.id) return
  const records = await serviceBoundary.call(ctx, signal, 'target authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: [target] },
    ], signal))
  if (records.length !== 1) throw serviceBoundary.unauthorizedTarget()
}

function assertObservedTargetAuthorized(
  _caller: Caller,
  target: SessionIdValue,
  observed: SessionHeader,
): void {
  if (observed.id !== target) {
    throw serviceBoundary.unauthorizedTarget()
  }
}

async function authorizeSessionIds(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  const unique = [...new Set(ids)]
  const authorized = new Set<SessionIdValue>()
  if (unique.includes(caller.id)) authorized.add(caller.id)
  const other = unique.filter(id => id !== caller.id)
  if (other.length === 0) return authorized
  const records = await serviceBoundary.call(ctx, signal, 'session-id authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: other },
    ], signal))
  const requested = new Set(other)
  for (const record of records) {
    if (requested.has(record.header.id)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

async function readTitles(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  const observations = await serviceBoundary.call(ctx, signal, 'title observation', () =>
    ctx.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      result.set(observation.sessionId, unavailableTitle(ctx, observation.reason))
      continue
    }
    assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session)
    result.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  caller: Caller,
  id: SessionIdValue,
  signal: AbortSignal,
): Promise<TitleView> {
  return (await readTitles(ctx, caller, [id], signal)).get(id)
}

function unavailableTitle(
  ctx: Context,
  error: unknown,
): TitleView {
  const sanitized = serviceBoundary.sanitizeError(ctx, 'title observation item', error)
  if (sanitized.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') throw sanitized
  return { text: 'untitled', unavailableCode: sanitized.code }
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  _caller: Caller,
): AuthorizedDescendant[] {
  const result: AuthorizedDescendant[] = []
  let pending: DescendantProjectionFrame | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, target: result, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    const projected: AuthorizedDescendant = {
      record: current.node.session,
      descendants: [],
    }
    current.target.push(projected)
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        target: projected.descendants,
        next: pending,
      }
    }
  }
  return result
}

function * visitDescendants(
  nodes: readonly AuthorizedDescendant[],
): Generator<DescendantVisit> {
  let pending: DescendantVisit | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, depth: 0, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    yield current
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        depth: current.depth + 1,
        next: pending,
      }
    }
  }
}

function descendantIds(nodes: readonly AuthorizedDescendant[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const { node } of visitDescendants(nodes)) ids.push(node.record.header.id)
  return ids
}

function titleText(view: TitleView): string {
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

/** Workspace-scoped caller authorization, title access, and lineage projection. */
export const workspaceAccess = {
  callerOf,
  targetId,
  authorizeTarget,
  assertObservedTargetAuthorized,
  authorizeSessionIds,
  readTitles,
  readTitle,
  authorizeDescendants,
  visitDescendants,
  descendantIds,
  titleText,
}
