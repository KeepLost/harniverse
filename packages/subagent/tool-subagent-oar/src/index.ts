/** One delegation tool selects a configured external provider for each task. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'

export const name = 'tool-subagent-oar'
export const inject = ['tools', 'subagents']

/** Deployment-owned runtime choices exposed by the external delegation tool. */
export interface Config {
  /** Model-visible runtime aliases mapped to registered subagent provider names. */
  providers: Record<string, string>
  /** Model-facing tool name (default subagent_oar). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  providers: z.dict(z.string().min(1)).required(),
  toolName: z.string().min(1).default('subagent_oar'),
})

/** One completed one-shot delegation as the tool's canonical output. */
interface OneShotResult {
  readonly mode: 'sync'
  readonly invocationId: string
  readonly sessionId: string
  readonly output: JsonValue[]
}

/** Flatten a non-completed stop reason with its diagnostic and partial text. */
function stopReasonError(result: SubagentResult): Error | undefined {
  if (result.stopReason === 'completed') return undefined
  const partial = result.output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
  const diagnostic = result.diagnostic === undefined ? '' : ` ${result.diagnostic}`
  return new Error(
    `subagent_oar child stopped early (${result.stopReason}).${diagnostic}`
    + (partial.length === 0 ? '' : ` Partial output:\n${partial}`),
  )
}

/**
 * Collect and release one one-shot run without letting disposal replace an
 * independent result failure.
 * @param run - the published provider run.
 * @returns the canonical tool output for a completed run.
 */
async function settleOneShotRun(run: SubagentRun): Promise<OneShotResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): OneShotResult => {
      const error = stopReasonError(result)
      if (error !== undefined) throw error
      return {
        mode: 'sync',
        invocationId: run.id,
        sessionId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent_oar run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Register a tool that selects one configured external provider per task.
 * @param ctx - shared tool registry and managed subagent service.
 * @param config - runtime choices and the model-facing tool name.
 */
export function apply(ctx: Context, config: Config): void {
  const providers = new Map(Object.entries(config.providers))
  if (providers.size === 0 || [...providers.keys()].some(runtime => runtime.trim().length === 0)) {
    throw new Error('subagent_oar: providers must contain at least one non-empty runtime alias')
  }
  const toolName = config.toolName ?? 'subagent_oar'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a configured external agent. Choose its runtime for each call. '
      + 'The child works in its own context and does not see this conversation, does not accept follow-up messages, '
      + 'and cannot outlive this call: the tool waits for the child\'s single turn and returns its final answer. '
      + 'Start independent tasks together in one message and keep working while they run. '
      + 'When only waiting for their results remains, end your turn instead of polling.',
    parameters: {
      runtime: {
        type: 'string',
        required: true,
        enum: [...providers.keys()],
        description: 'Configured external runtime for this task.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task. Include all context the external agent needs.',
      },
    },
    /* jscpd:ignore-start -- External and local delegation share the canonical
     * invocation acknowledgement; their provider-selection policies remain separate. */
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, const: 'sync' },
          invocationId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Subagent session ${value.sessionId} completed invocation ${value.invocationId}. `
          + `This one-shot Session does not accept later turns.\n\nFinal output:\n${
            value.output
              .map(part => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')
              .join('')
          }`,
      }],
    },
    /* jscpd:ignore-end */
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('subagent_oar requires a calling agent')
      // The parameter enum admits only keys from this immutable configuration.
      const providerName = providers.get(args.runtime) as string
      const provider = ctx.subagents.getProvider(providerName)
      if (provider !== undefined && (provider.prepareContinuable !== undefined || provider.inheritsParentContext)) {
        throw new Error('subagent_oar requires a one-shot provider with independent conversation context')
      }
      // External one-shot providers are exactly the retained legacy callers of the one-shot seam.
      // oxlint-disable-next-line typescript/no-deprecated -- the continuable invoke path cannot serve one-shot providers.
      const run = await ctx.subagents.start(providerName, {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        signal: exec.signal,
      })
      return await settleOneShotRun(run)
    },
    presentCall: args => ({ card: 'generic', title: args.description, rawInput: args }),
  }))
}
