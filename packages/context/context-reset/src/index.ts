/**
 * Context-reset service (`ctx.contextReset`): replaces the entire current
 * surface with one verbatim checkpoint marker so the next model request starts
 * from a fresh context while the retained log stays append-only and searchable.
 * The durable record is a single replacement `user/message` carrying
 * {@link resetCheckpointSource}; no dedicated lock events are needed because the
 * transaction is one atomic append.
 * @module @deepseek-ai/dsh-context-reset
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { ResetId } from './brand.ts'
import { resetCheckpointContent, resetCheckpointSource } from './checkpoint.ts'
import type { ContextResetResult } from './types.ts'

export { ResetId } from './brand.ts'
// The checkpoint source constructor and predicate are declared on the
// cordis-free `./checkpoint` leaf so client and wire programs can name them
// without this root's Context merge; the root stays the host-side entry point.
export { resetCheckpointContent, resetCheckpointSource, isResetCheckpointSource } from './checkpoint.ts'
export type { ResetCheckpointSource } from './checkpoint.ts'
export type { ContextResetResult } from './types.ts'

/** Expected failure classes for an explicit idle-session context reset. */
export type ContextResetErrorCode =
  | 'busy'
  | 'cancelled'
  | 'commit'
  | 'persistence'

/** Expected context-reset failure suitable for a direct human-command result. */
export class ContextResetError extends Error {
  override readonly name = 'ContextResetError'

  /**
   * Create one classified context-reset failure.
   * @param code - stable failure class.
   * @param message - diagnostic retained as the Error message.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: ContextResetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Await one running agent's idle boundary, rejecting promptly on cancellation. */
function waitForAgentIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => {
    aborted.reject(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return Promise.race([agent.whenIdle(), aborted.promise]).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextReset: ContextResetService
  }
}

/**
 * Whole-surface context reset. A successful run replaces every current surface
 * node with one checkpoint marker and leaves the shadowed history in the log.
 * Load one instance per context as `ctx.contextReset`.
 */
export class ContextResetService extends Service {
  static inject = ['sessions']

  private readonly ownerCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'contextReset')
    this.ownerCtx = ctx
  }

  /**
   * Explicitly reset the model context even while the log keeps growing.
   * The operation synchronously starts an idle task before any asynchronous
   * work, replaces the whole current surface in one atomic append, then waits
   * for one durability flush. Later waking prompts remain accepted in FIFO
   * order and start only after the flush settles.
   *
   * @param agent - agent whose session surface should be reset.
   * @param signal - cancellation scoped to this reset request.
   * @param sourceCommandId - initiating command identity for a manual reset.
   * @returns the reset result, or `null` when the surface is already empty.
   * @throws {@link ContextResetError} for expected busy, agent-cancellation,
   * commit-stage, or persistence failures; an aborted request preserves its
   * exact abort reason.
   */
  resetNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<ContextResetResult | null> {
    signal.throwIfAborted()
    const settled = Promise.withResolvers<void>()
    const release = this.ownerCtx.effect(
      () => async () => { await settled.promise },
      'context-reset resetNow operation',
    )
    return (async () => {
      try {
        return await this.performResetNow(agent, signal, sourceCommandId)
      } finally {
        settled.resolve()
        await release()
      }
    })()
  }

  /**
   * Run the reset behind the lifecycle-owned public operation.
   * @param agent - agent whose session surface should be reset.
   * @param signal - cancellation scoped to this reset request.
   * @param sourceCommandId - initiating command identity for a manual reset.
   * @returns the reset result, or `null` when the surface is already empty.
   */
  private async performResetNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<ContextResetResult | null> {
    if (agent.status === 'running') {
      await waitForAgentIdle(agent, signal)
      return this.performResetNow(agent, signal, sourceCommandId)
    }
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await this.appendResetCheckpoint(
            agent.session,
            sourceCommandId,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ContextResetError(
              'cancelled',
              'context reset was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      if (signal.aborted || error instanceof ContextResetError) throw error
      throw new ContextResetError(
        'busy',
        'context reset requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Append the durable anchor and whole-surface replacement marker, then flush
   * them durably.
   * @param session - session whose complete current surface is shadowed.
   * @param sourceCommandId - initiating command identity for a manual reset.
   * @returns the reset result, or `null` when the surface is already empty.
   */
  private async appendResetCheckpoint(
    session: Session,
    sourceCommandId?: CommandId,
  ): Promise<ContextResetResult | null> {
    const nodes = session.surface.nodes
    if (nodes.length === 0) return null
    const resetId = ResetId(randomUUID())
    const provenance = {
      resetId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
    }
    const message = createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(resetId, sourceCommandId),
    })
    let checkpointSeq: number
    let markerSeq: number
    try {
      const first = nodes[0]
      const last = nodes.at(-1)
      /* v8 ignore next 3 -- defensive read-recheck; the maintenance phase holds the writer lock, so an empty node list is unreachable */
      if (first === undefined || last === undefined) {
        throw new Error('surface nodes vanished between read and append')
      }
      const anchor = session.append('reset/checkpoint', { ...provenance, turn: null })
      const marker = session.append('user/message', message, {
        surfaceOp: { op: 'replace', start: first, end: last },
        sourceEventSeqs: [anchor.seq, ...nodes],
      })
      checkpointSeq = anchor.seq
      markerSeq = marker.seq
    } catch (error: unknown) {
      throw new ContextResetError(
        'commit',
        'the reset marker could not be appended; the conversation is unchanged',
        { cause: error },
      )
    }
    try {
      await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      throw new ContextResetError(
        'persistence',
        'the reset marker was appended but could not be saved',
        { cause: error },
      )
    }
    return {
      ...provenance,
      checkpointSeq,
      markerSeq,
      shadowedSeqs: Object.freeze([...nodes]),
    }
  }
}

export default ContextResetService
