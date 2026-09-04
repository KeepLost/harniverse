/** Cross-model fallback for durable Session Model Routes. */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { effectiveModelTarget } from '@deepseek-ai/dsh-model-policy'
import type { ModelSelection } from '@deepseek-ai/dsh-model-policy/types'
import type {} from '@deepseek-ai/dsh-model-policy'

export const name = 'model-policy-fallback'
export const inject = ['agents', 'modelPolicy', 'sessions']

/** Empty configuration: route definitions and profile grants own the policy. */
export type Config = Readonly<Record<string, never>>
/** Runtime schema for the empty executor configuration. */
export const Config = z.object({}) as unknown as z<Config>

/** Return the latest fallback transition for one request step. */
function latestFallback(events: readonly SessionEvent[], turn: number, step: number): Extract<SessionEvent, { type: 'model/fallback' }> | undefined {
  return events.findLast((event): event is Extract<SessionEvent, { type: 'model/fallback' }> =>
    event.type === 'model/fallback' && event.data.turn === turn && event.data.step === step)
}

function sameModel(a: ModelSelection, b: { provider: string; model: string }): boolean {
  return a.provider === b.provider && a.model === b.model
}

function isCancellation(failure: LlmFailure): boolean {
  return failure.code === 'ABORTED' || failure.code === 'CANCELLED' || failure.code === 'CANCELED'
}

/** Copy a policy selection into an Agent request config without stale effort values. */
function replaceModel(config: LlmCallConfig, selection: ModelSelection): LlmCallConfig {
  const next = { ...config, provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort === undefined) {
    const { reasoningEffort: _ignored, ...withoutEffort } = next
    return withoutEffort
  }
  return {
    ...next,
    reasoningEffort: selection.reasoningEffort as NonNullable<LlmCallConfig['reasoningEffort']>,
  }
}

function failureSnapshot(failure: LlmFailure): { message: string; code: string; status?: number } {
  return {
    message: failure.message,
    code: failure.code,
    ...failure.status === undefined ? {} : { status: failure.status },
  }
}

/** Install route fallback after same-model recovery delegates. */
export function apply(ctx: Context, _config: Config = {}): void {
  const lifetime = new AbortController()
  const policy = ctx.get('modelPolicy')
  if (policy === undefined) throw new Error('model-policy-fallback requires modelPolicy')

  const streamListener = ctx.on('llm/stream', (
    options: LlmCallConfig & { sessionId?: string },
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.get('sessions')?.get(options.sessionId as never)
    if (session === undefined) throw new LlmError(`session "${options.sessionId}" is not attached`, 'SESSION_NOT_FOUND')
    const profile = policy.profileOf(session)
    if (!policy.allowsConcrete(profile, options)) {
      throw new LlmError(`model ${options.provider}/${options.model} is not allowed by profile "${profile.id}"`, 'MODEL_NOT_ALLOWED')
    }
    return next()
  }, { global: true })

  const requestListener = ctx.on('agent/request', async (
    payload: Parameters<Events['agent/request']>[0],
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const config = await next()
    if (lifetime.signal.aborted) return config
    const fallback = latestFallback(payload.agent.session.events, payload.turn, payload.step)
    return fallback === undefined ? config : replaceModel(config, fallback.data.to)
  })

  const errorListener = ctx.on('agent/request-error', async (
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    const downstream = await next()
    if (downstream?.kind === 'retry' || lifetime.signal.aborted || payload.signal.aborted || isCancellation(payload.failure)) {
      return downstream
    }
    const target = effectiveModelTarget(payload.agent.session.events)
    if (target === undefined || target.kind !== 'route') return downstream
    const targets = policy.targetsFor(payload.agent.session, target)
    if (targets.length < 2) return downstream
    const prior = latestFallback(payload.agent.session.events, payload.turn, payload.step)
    const currentModel = payload.model ?? targets[0]?.model
    if (currentModel === undefined) return downstream
    const current: ModelSelection = {
      provider: payload.provider,
      model: currentModel,
    }
    const currentIndex = prior === undefined
      ? targets.findIndex(candidate => sameModel(candidate, current))
      : targets.findIndex(candidate => sameModel(candidate, prior.data.to))
    const nextSelection = targets[currentIndex + 1]
    if (nextSelection === undefined) return downstream
    payload.agent.session.append('model/fallback', {
      turn: payload.turn,
      step: payload.step,
      route: target.route,
      from: current,
      to: nextSelection,
      failure: failureSnapshot(payload.failure),
    })
    return { kind: 'retry' }
  })

  ctx.effect(() => () => {
    requestListener()
    errorListener()
    streamListener()
    lifetime.abort(new Error('model-policy-fallback plugin disposed'))
  }, 'model-policy-fallback: dispose listeners')
}
