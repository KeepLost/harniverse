/**
 * Model-facing request for proactive compaction of older conversation history.
 * @module @deepseek-ai/dsh-tool-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-compaction'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-compaction'
/** Capability services required by this model-facing consumer. */
export const inject = ['tools', 'compaction', 'tokenMeter']

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PARAMETERS = {
  reason: {
    type: 'string' as const,
    required: true,
    description: 'Briefly explain why older context can be condensed now.',
  },
  from: {
    type: 'number' as const,
    description: 'First message to compact, as a 1-based position from the oldest retained message. Omit both positions to let policy choose the span.',
  },
  to: {
    type: 'number' as const,
    description: 'Last message to compact, inclusive, in the same positioning. The span must end before the current turn; boundaries snap to keep tool calls paired.',
  },
} as const

/** One resolved explicit span in surface-sequence terms. */
interface ResolvedSpan {
  readonly start: number
  readonly end: number
  /** Positions dropped from the span by boundary snapping. */
  readonly snapped: number
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Resolve requested 1-based positions against the closed-turn surface.
 * Boundaries snap so no tool call is split from its result; a span that
 * empties out or reaches into the open turn is rejected with the usable cap.
 * @param session - session whose surface positions are addressed.
 * @param from - requested first position, 1-based.
 * @param to - requested last position, inclusive.
 * @returns the resolved span, or a human-readable rejection reason.
 * @internal
 */
export function resolveSpan(
  session: import('@deepseek-ai/dsh-session').Session,
  from: number,
  to: number,
): ResolvedSpan | { error: string } {
  const nodes = session.surface.nodes
  const closedEnd = session.events.findLast(event => event.type === 'turn/end')?.seq ?? -1
  const closed = nodes.filter(seq => seq <= closedEnd)
  if (closed.length === 0) {
    return { error: 'No closed-turn history is available to compact yet.' }
  }
  if (!isPositiveInteger(from) || !isPositiveInteger(to)) {
    return { error: 'context_compact from/to must be positive whole positions.' }
  }
  if (to < from) return { error: 'context_compact from must not exceed to.' }
  if (from > closed.length) {
    return { error: `context_compact positions must stay within the ${closed.length} closed-turn messages.` }
  }
  let start = from - 1
  let end = Math.min(to, closed.length) - 1
  const requested = end - start + 1
  // A cut entering the span must not orphan a call whose result would be
  // shadowed; advancing the start keeps such pairs whole on the kept side.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- start <= end bounds the index
  while (start <= end && !toolPairingBalancedBefore(session, closed[start]!)) start += 1
  // A cut leaving the span must not orphan a call whose result stays kept;
  // shrinking the end keeps such pairs whole on the tail side.
  while (start <= end) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- end + 1 <= closed.length bounds the index
    const entering = end + 1 < closed.length ? closed[end + 1]! : undefined
    const balanced = entering === undefined
      // oxlint-disable-next-line typescript/no-non-null-assertion -- start <= end bounds the index
      ? toolPairingBalancedAfter(session, closed[end]!)
      : toolPairingBalancedBefore(session, entering)
    if (balanced) break
    end -= 1
  }
  if (start > end) {
    return { error: 'The requested span collapses after keeping tool calls paired; choose a wider span.' }
  }
  return {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- start <= end bounds the index
    start: closed[start]!,
    // oxlint-disable-next-line typescript/no-non-null-assertion -- start <= end bounds the index
    end: closed[end]!,
    snapped: requested - (end - start + 1),
  }
}

/** Register the active-agent compaction tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'context_compact',
    description: 'Compact older conversation history while retaining recent context. Use after detailed prior context is no longer needed.',
    parameters: PARAMETERS,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('context_compact requires an active agent session')
      if (exec.parent !== undefined) throw new Error('context_compact cannot run inside another tool')
      if (args.reason.trim().length === 0) throw new TypeError('context_compact reason must not be empty')

      if (args.from === undefined && args.to === undefined) {
        const result = await ctx.compaction.compactIfNeeded(exec.agent, 'agent-request', exec.signal)
        if (result === null) return 'No compactable older history is available yet.'
        return `Compacted ${result.shadowedSeqs.length} older history items `
          + `(~${result.shadowedTokenCount} tokens) while retaining recent context.`
      }
      if ((args.from === undefined) !== (args.to === undefined)) {
        throw new TypeError('context_compact from and to must be provided together.')
      }
      const resolved = resolveSpan(exec.agent.session, args.from as number, args.to as number)
      if ('error' in resolved) return resolved.error
      const result = await ctx.compaction.compactRegion(resolved.start, resolved.end, exec.agent, exec.signal)
      const retained = ctx.tokenMeter.measure(exec.agent.session).totalTokens
      return `Compacted ${result.shadowedSeqs.length} history items `
        + `(~${result.shadowedTokenCount} tokens); retained context is ~${retained} tokens`
        + (resolved.snapped > 0 ? ` (${resolved.snapped} position${resolved.snapped === 1 ? '' : 's'} snapped to keep tool calls paired)` : '')
        + '.'
    },
  }))
}
