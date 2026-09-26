/**
 * Request-option translation for the two wire protocols this adapter assembles
 * itself: OpenAI Responses and Anthropic Messages.
 *
 * `streamSimple()` collapses the reasoning selection before the protocol sees
 * it — an absent option and an explicit `off` both become "no reasoning", which
 * Anthropic Messages then wires as an explicit `thinking: disabled` and OpenAI
 * Responses as an explicit `effort: none`. For models whose provider default
 * is to think, that silently changes the request nobody made. This module
 * keeps the four states apart — default, off, effort, budget — and hands the
 * protocol's own `stream()` options to pi-ai, so each protocol receives the
 * selection in its own vocabulary. Every other protocol keeps
 * `streamSimple()`, where its own dispatch already decides these fields.
 *
 * @module dsh-llm-pi-ai/request-options
 */

import type {
  AnthropicEffort,
  Api,
  AnthropicOptions,
  Model,
  ModelThinkingLevel,
  OpenAIResponsesOptions,
  ThinkingBudgets,
} from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Stream options carrying both translated protocols' extras. pi-ai ignores
 * the extras a protocol does not define, so one object serves either path.
 */
export type PiProtocolStreamOptions = OpenAIResponsesOptions & AnthropicOptions

/**
 * Token budgets pi-ai spends on a thinking level when no profile budget
 * names one, mirroring its `adjustMaxTokensForThinking` table so a level
 * behaves the same whether this adapter or `streamSimple()` dispatched it.
 */
const DEFAULT_THINKING_BUDGETS: Readonly<Record<Exclude<ModelThinkingLevel, 'off'>, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 16384,
  max: 16384,
}

/** The smallest thinking budget Anthropic Messages accepts. */
const MIN_ANTHROPIC_BUDGET = 1024

/** The smallest output cap OpenAI Responses accepts. */
const MIN_OPENAI_OUTPUT_TOKENS = 16

/** The request selections this adapter has already validated. */
export interface PiRequestSelections {
  /** Requested reasoning level; `undefined` keeps the provider default, `off` disables. */
  reasoning: ModelThinkingLevel | undefined
  /** Profile-configured token budgets, when any. */
  thinkingBudgets: ThinkingBudgets | undefined
  /** Caller's explicit output cap; never defaulted to the model capability here. */
  maxTokens: number | undefined
  /** Caller's sampling temperature, when any. */
  temperature: number | undefined
}

/**
 * The effort an adaptive-thinking Anthropic model dispatches for one level,
 * mirroring pi-ai's own mapping: a `thinkingLevelMap` spelling wins, else the
 * level's own name among `low`/`medium`/`high`, escalating to `high`.
 * @param model - the resolved model descriptor.
 * @param level - the requested thinking level.
 * @returns the effort the request carries.
 */
function adaptiveEffort(model: Model<Api>, level: Exclude<ModelThinkingLevel, 'off'>): AnthropicEffort {
  const mapped = model.thinkingLevelMap?.[level]
  if (typeof mapped === 'string') return mapped as AnthropicEffort
  switch (level) {
    case 'minimal':
    case 'low': return 'low'
    case 'medium': return 'medium'
    default: return 'high'
  }
}

/**
 * The budget a budget-thinking Anthropic model dispatches for one level,
 * fitted inside the output cap without ever raising it: the caller's cap is
 * the cap, so the budget shrinks to leave the reply its room, and a cap that
 * cannot host the smallest legal budget is refused before the network.
 * @param model - the resolved model descriptor.
 * @param selections - the request selections.
 * @returns the budget tokens the request carries.
 * @throws LlmError when the effective output cap leaves no legal budget.
 */
function fittedBudget(
  model: Model<Api>,
  level: Exclude<ModelThinkingLevel, 'off'>,
  selections: PiRequestSelections,
): number {
  const cap = selections.maxTokens ?? model.maxTokens
  // A profile budget spells only pi-ai's budget-carrying levels; the
  // escalated pair rides the default table, as `streamSimple()` clamps them.
  const custom = level === 'xhigh' || level === 'max'
    ? undefined
    : selections.thinkingBudgets?.[level]
  const wanted = custom ?? DEFAULT_THINKING_BUDGETS[level]
  const fitted = Math.min(wanted, cap - MIN_ANTHROPIC_BUDGET)
  if (fitted < MIN_ANTHROPIC_BUDGET) {
    throw new LlmError(
      `anthropic thinking needs a budget of at least ${String(MIN_ANTHROPIC_BUDGET)} tokens inside the output cap;`
      + ` raise maxTokens above ${String(cap)} or set reasoning to "off"`,
      'UNSUPPORTED_OPTION',
    )
  }
  return fitted
}

/**
 * Whether a temperature may travel with this selection. Both translated
 * protocols refuse sampling parameters while thinking runs, and a model whose
 * provider default is to think may think with no selection at all — so the
 * temperature waits for an explicit `off` (or a model that cannot think).
 * @param model - the resolved model descriptor.
 * @param reasoning - the requested reasoning level.
 * @returns whether the request may carry the caller's temperature.
 */
function temperatureAllowed(model: Model<Api>, reasoning: ModelThinkingLevel | undefined): boolean {
  if (!model.reasoning) return true
  if (reasoning === 'off') return true
  // OpenAI Responses dispatches an unselected reasoning model as `effort:
  // none` — thinking is off on the wire, so the temperature is safe there.
  return model.api === 'openai-responses' && reasoning === undefined
}

/**
 * Translate one request's selections into the protocol-owned stream options.
 * @param model - the resolved model descriptor; its `api` names the protocol.
 * @param selections - the adapter's validated request selections.
 * @returns options for `Models.stream()` on that protocol.
 * @throws LlmError when the selections cannot be served on the wire at all.
 */
export function piStreamOptions(model: Model<Api>, selections: PiRequestSelections): PiProtocolStreamOptions {
  const options: PiProtocolStreamOptions = {}
  const level = selections.reasoning
  if (model.api === 'anthropic-messages') {
    // `max_tokens` is required on this protocol, so an absent caller cap uses
    // the model's capability — the one place a capability becomes a request
    // value, because the wire format leaves nothing to omit.
    options.maxTokens = selections.maxTokens ?? model.maxTokens
    // `Model.compat` narrows by api, so the anthropic spelling arrives through
    // the descriptor's own union here.
    const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined
    if (level === undefined) {
      // No thinking field at all: the provider default, which for
      // adaptive-thinking models is to think.
    } else if (level === 'off') {
      options.thinkingEnabled = false
    } else if (compat?.forceAdaptiveThinking === true) {
      options.thinkingEnabled = true
      options.effort = adaptiveEffort(model, level)
    } else {
      options.thinkingEnabled = true
      options.thinkingBudgetTokens = fittedBudget(model, level, selections)
    }
  } else {
    // OpenAI Responses: an absent cap is omitted so the provider's own default
    // applies, and a sub-floor cap is refused rather than silently raised to
    // the floor pi-ai would apply.
    if (selections.maxTokens !== undefined) {
      if (selections.maxTokens < MIN_OPENAI_OUTPUT_TOKENS) {
        throw new LlmError(
          `openai-responses output caps must be at least ${String(MIN_OPENAI_OUTPUT_TOKENS)} tokens;`
          + ' raise maxTokens or leave it unset for the provider default',
          'UNSUPPORTED_OPTION',
        )
      }
      options.maxTokens = selections.maxTokens
    }
    if (level !== undefined && level !== 'off') options.reasoningEffort = level
  }
  if (selections.temperature !== undefined && temperatureAllowed(model, level)) {
    options.temperature = selections.temperature
  }
  return options
}
