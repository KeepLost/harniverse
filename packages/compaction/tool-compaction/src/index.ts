/**
 * Model-facing request for proactive compaction of older conversation history.
 * @module @deepseek-ai/dsh-tool-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-compaction'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-compaction'
/** Capability services required by this model-facing consumer. */
export const inject = ['tools', 'compaction']

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
} as const

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

      const result = await ctx.compaction.compactIfNeeded(exec.agent, 'agent-request', exec.signal)
      if (result === null) return 'No compactable older history is available yet.'
      return `Compacted ${result.shadowedSeqs.length} older history items `
        + `(~${result.shadowedTokenCount} tokens) while retaining recent context.`
    },
  }))
}
