/**
 * Threshold-gated context-pressure notices delivered through the non-waking
 * `agent.inject()` inbox.
 *
 * @module @deepseek-ai/dsh-context-nudge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-compaction'

export const name = 'context-nudge'
export const inject = ['agents', 'systemPrompt', 'tokenMeter']

const SOURCE = '@deepseek-ai/dsh-context-nudge'
const COMPACT_TOOL = 'context_compact'
// Mirrored from dsh-compaction-settings so the plugin stays dependency-free;
// the namespace string is the stable contract between the two packages.
const COMPACTION_SETTINGS_NAMESPACE = 'compaction'

/** Default first-notice threshold in estimated framed tokens. */
export const DEFAULT_THRESHOLD_TOKENS = 120_000
/** Default growth between notices in estimated framed tokens. */
export const DEFAULT_REFIRE_DELTA_TOKENS = 20_000

/** Composition-level defaults; live user overrides arrive through settings. */
export interface ContextNudgeConfig {
  /** First-notice threshold in estimated framed tokens. */
  thresholdTokens?: number
  /** Growth between notices in estimated framed tokens. */
  refireDeltaTokens?: number
  /** Whether notices are delivered at all. */
  enabled?: boolean
}

/** One runtime override record read from the compaction settings namespace. */
interface NudgeSettings {
  nudgeEnabled?: boolean
  nudgeThresholdTokens?: number
  nudgeRefireDeltaTokens?: number
}

/** Per-agent firing state; re-derivable and disposable with the agent. */
interface AgentState {
  /** Measurement at the last delivered notice; `undefined` while armed. */
  lastFireTokens: number | undefined
  /** Whether the agent's tool catalog exposes the compaction tool. */
  toolPresent: boolean | undefined
}

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function notice(text: string, measuredTokens: number, thresholdTokens: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: SOURCE,
      form: 'system-injection',
      measuredTokens,
      thresholdTokens,
    },
  })
}

function noticeText(measuredTokens: number): string {
  return 'Context pressure notice: the retained conversation is '
    + `~${measuredTokens} tokens. When older spans are no longer needed verbatim, `
    + 'call context_compact on them to reclaim context before the window fills.'
}

/**
 * Read and validate the effective notice policy. An invalid live override is
 * reported once and ignored in favor of the composition defaults.
 * @returns the effective threshold, refire delta, and enabled flag.
 */
function effectivePolicy(
  ctx: Context,
  config: ContextNudgeConfig,
  warned: Set<string>,
): { thresholdTokens: number; refireDeltaTokens: number; enabled: boolean } {
  const provider = ctx.get('settings') as { get(namespace: string): unknown } | undefined
  const settings = provider?.get(COMPACTION_SETTINGS_NAMESPACE) as NudgeSettings | undefined
  const read = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
  const thresholdTokens = read(settings?.nudgeThresholdTokens) ?? config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS
  const refireDeltaTokens = read(settings?.nudgeRefireDeltaTokens) ?? config.refireDeltaTokens ?? DEFAULT_REFIRE_DELTA_TOKENS
  const enabled = settings?.nudgeEnabled ?? config.enabled ?? true
  if (refireDeltaTokens >= thresholdTokens) {
    if (!warned.has('policy')) {
      warned.add('policy')
      ctx.logger.warn(
        `context-nudge: refire delta (${refireDeltaTokens}) must be smaller than the threshold `
        + `(${thresholdTokens}); using the composition defaults`,
      )
    }
    return {
      thresholdTokens: config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS,
      refireDeltaTokens: config.refireDeltaTokens ?? DEFAULT_REFIRE_DELTA_TOKENS,
      enabled,
    }
  }
  return { thresholdTokens, refireDeltaTokens, enabled }
}

/**
 * Whether the agent's assembled tool catalog exposes the compaction tool.
 * Cached per agent: tool discovery is stable while the composition is
 * unchanged, and a notice to a toolless agent is misleading noise.
 */
async function toolPresent(ctx: Context, agent: Agent, state: AgentState): Promise<boolean> {
  if (state.toolPresent !== undefined) return state.toolPresent
  try {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    state.toolPresent = assembly.tools.some(tool => tool.name === COMPACT_TOOL)
  } catch (error: unknown) {
    ctx.logger.warn(`context-nudge: tool catalog unavailable: ${String(error)}`)
    state.toolPresent = false
  }
  return state.toolPresent
}

/**
 * Deliver the notice through the non-waking inbox: a running driver claims it
 * at its next step boundary, an idle one leaves it pending until the next
 * user prompt or steering arrives.
 */
function deliver(agent: Agent, ctx: Context, measuredTokens: number, thresholdTokens: number): void {
  try {
    agent.inject(notice(noticeText(measuredTokens), measuredTokens, thresholdTokens))
  } catch (error: unknown) {
    ctx.logger.warn(`context-nudge: could not queue a notice: ${String(error)}`)
  }
}

/**
 * Register the context-pressure notice consumer.
 * @param ctx - root context carrying the agent, prompt, and meter services.
 * @param config - composition-level defaults for the notice policy.
 */
export function apply(ctx: Context, config: ContextNudgeConfig = {}): void {
  const warned = new Set<string>()
  const states = new WeakMap<Agent, AgentState>()
  const stateFor = (agent: Agent): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created: AgentState = { lastFireTokens: undefined, toolPresent: undefined }
    states.set(agent, created)
    return created
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // Occupancy only moves at durable surface boundaries: a human or tool
    // message grows it, an assistant reply records the step's growth, and a
    // committed compaction shrinks it. The nudge's own pending messages are
    // excluded so a delivered notice cannot re-trigger itself before the
    // model acts.
    if (event.type !== 'user/message' && event.type !== 'assistant/message'
      && event.type !== 'tool/result' && event.type !== 'compaction/end') return
    if (event.type === 'user/message' && isOwned(event.data)) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const state = stateFor(agent)
    const { thresholdTokens, refireDeltaTokens, enabled } = effectivePolicy(ctx, config, warned)
    if (!enabled) return
    const measuredTokens = ctx.tokenMeter.measure(session).totalTokens
    if (state.lastFireTokens !== undefined) {
      // Hysteresis: a shrink past the last firing's floor re-arms the first
      // notice so post-compaction occupancy does not linger disarmed.
      if (measuredTokens <= state.lastFireTokens - refireDeltaTokens) {
        state.lastFireTokens = undefined
        return
      }
      if (measuredTokens < state.lastFireTokens + refireDeltaTokens) return
    } else if (measuredTokens < thresholdTokens) {
      return
    }
    void toolPresent(ctx, agent, state).then((present) => {
      if (!present) return
      // Re-measure at delivery: compaction may have shrunk the session while
      // the catalog resolved, and a below-threshold notice is noise.
      const current = ctx.tokenMeter.measure(agent.session).totalTokens
      const due = state.lastFireTokens === undefined
        ? current >= thresholdTokens
        : current >= state.lastFireTokens + refireDeltaTokens
      if (!due) return
      state.lastFireTokens = current
      deliver(agent, ctx, current, thresholdTokens)
    })
  })
}
