/**
 * Durable age-based image offload for the model-request projection.
 *
 * Mounts the `image/offload` message projection on the session store and, at
 * every agent request boundary, resolves the configured
 * `imageOffloadAfterUserTurns` age limit against the durable log: images
 * whose later-user-turn age reached the limit are settled by one appended
 * `image/offload` event, and every later model request renders the canonical
 * offload stub in their place. Original attachments stay retained for replay
 * and authorized re-reads; display surfaces that read events directly keep
 * showing the original images.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `agent/request` Events merge the listener uses.
import type {} from '@deepseek-ai/dsh-agent'
import { COMPACTION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-compaction-settings'
import type { CompactionSettings } from '@deepseek-ai/dsh-compaction-settings'
import { parseImageOffloadSetting, resolveImageOffloadDecisions } from '@deepseek-ai/dsh-image-offload-policy'
import type { ImageOffloadSetting } from '@deepseek-ai/dsh-image-offload-policy'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { imageHandleText } from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from './projection.ts'
import { imageCarrier } from './project-message.ts'

/** Cordis plugin name. */
export const name = 'compaction-image-offload'
/** The session store owns message-projection registration. */
export const inject = ['sessions']

/**
 * Read the effective age limit: the stored compaction setting when a settings
 * provider is present, `'unlimited'` otherwise.
 * @param ctx - plugin context.
 * @returns the validated setting.
 * @throws when a stored value is neither `'unlimited'` nor a positive integer.
 */
function readSetting(ctx: Context): ImageOffloadSetting {
  const stored = ctx.get('settings')?.get(COMPACTION_SETTINGS_NAMESPACE) as CompactionSettings | undefined
  const raw = stored?.imageOffloadAfterUserTurns
  return raw === undefined ? 'unlimited' : parseImageOffloadSetting(raw)
}

/**
 * Register the projection and the request-boundary decision listeners.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  // Prepend so the modality settlement runs outermost: `await next()` then
  // observes the final request config, including any model a fallback
  // listener substituted inside the waterfall.
  ctx.on('agent/request', async ({ agent }, next) => {
    const decisions = resolveImageOffloadDecisions(agent.session.events, { setting: readSetting(ctx) })
    if (decisions.length > 0) {
      agent.session.append('image/offload', { targets: decisions.map(decision => decision.target) })
    }
    const config = await next()
    await settleModalityOffload(ctx, agent.session, config)
    return config
  }, { prepend: true })
  ctx.on('llm/project-request', (_options, next) => {
    const options = next()
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    if (session === undefined) return options
    const decisions = resolveImageOffloadDecisions(session.events, { setting: readSetting(ctx) })
    if (decisions.length > 0) session.append('image/offload', { targets: decisions.map(decision => decision.target) })
    return projectRequest(session, options)
  })
}

/**
 * Settle every retained image occurrence before dispatch when the request's
 * final route accepts no image input. Each minted stub names the image and
 * its read-only hard-link path, so a later vision model can re-view the
 * original through `read_image`; the stub text rides the durable decision
 * and replays verbatim. Images produced later in the same session settle at
 * the next request boundary the same way. Skipped silently when the llm or
 * attachment service is absent, the model's input modalities are unknown,
 * or model resolution fails — the adapter's own image guard then stays the
 * loud safety net.
 * @param ctx - plugin context carrying the optional llm and attachment services.
 * @param session - the session whose next request is being assembled.
 * @param config - the final request config after the whole agent/request waterfall.
 */
async function settleModalityOffload(ctx: Context, session: Session, config: { provider?: string; model?: string }): Promise<void> {
  const decisions = resolveImageOffloadDecisions(session.events, { setting: readSetting(ctx), routeAcceptsImages: false })
  if (decisions.length === 0 || config.provider === undefined || config.model === undefined) return
  const llm = ctx.get('llm')
  /* v8 ignore next 1 -- the waterfall only runs beside the injected llm service; defensive for llm-free compositions. */
  if (llm === undefined) return
  let inputModalities: readonly string[] | undefined
  try {
    inputModalities = (await llm.resolveModelInfo(config.provider, config.model)).inputModalities
  } catch {
    return
  }
  if (inputModalities === undefined) return
  if (inputModalities.includes('image')) return
  const attachments = ctx.get('attachments')
  /* v8 ignore next 1 -- minting a decision requires the store that saved the image; defensive for store-less mounts. */
  if (attachments === undefined) return
  const targets = await Promise.all(decisions.map(async (decision) => {
    const event = session.eventAt(decision.target.messageSeq)
    /* v8 ignore next 1 -- targets are minted from this same event log moments earlier, so the event always resolves. */
    const carrier = event === undefined ? undefined : imageCarrier(event)
    const image = carrier
      ?.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
      [decision.target.imageIndex]
    /* v8 ignore next 4 -- resolver targets are minted from this same immutable carrier walk in this call, so the image always exists. */
    if (image === undefined) {
      throw new Error(`image/offload: modality target ${decision.target.messageSeq}:${decision.target.imageIndex} has no retained image`)
    }
    const path = await attachments.publishFileHandle(image.attachment)
    return { ...decision.target, stub: imageHandleText(image.attachment, path) }
  }))
  session.append('image/offload', { targets })
}

/** Bind provider pressure to the exact occurrences carried by this request. */
function projectRequest(session: Session, options: GenerateOptions): GenerateOptions {
  const seqById = new Map(session.surface.nodes.flatMap((seq) => {
    const message = session.projectedMessageAt(seq)
    return message === undefined ? [] : [[message.id, seq] as const]
  }))
  const refresh = (): Message[] => options.messages.map((message) => {
    const seq = seqById.get(message.id)
    return seq === undefined ? message : session.projectedMessageAt(seq) ?? message
  })
  let messages = refresh()
  return {
    ...options,
    messages,
    onImagesOmitted(targets) {
      const settled = new Map<string, { messageSeq: number; imageIndex: number }>()
      for (const target of targets) {
        const message = messages[target.message]
        const seq = message === undefined ? undefined : seqById.get(message.id)
        if (seq === undefined) throw new Error('image pressure target is not a durable session occurrence')
        const event = session.eventAt(seq)
        if (event === undefined) throw new Error('image pressure target has no source event')
        const base = imageCarrier(event)
        const projected = session.projectedMessageAt(seq)
        if (projected === undefined) throw new Error('image pressure source was replaced during the request')
        // Coordinates belong to this attempt's snapshot, even when another
        // request has already settled one of its images.
        const carrier = event.type === 'tool/result' ? message?.content[0] : undefined
        const blocks = carrier?.type === 'tool-result' ? carrier.content : message?.content
        const currentCarrier = event.type === 'tool/result' ? projected.content[0] : undefined
        const current = currentCarrier?.type === 'tool-result' ? currentCarrier.content : projected.content
        let originalIndex = 0
        let visibleIndex = 0
        let found = false
        if (base !== undefined && blocks !== undefined) {
          for (const [position, block] of base.entries()) {
            const projectedBlock = blocks[position]
            if (block.type !== 'image') continue
            if (projectedBlock?.type === 'image') {
              if (visibleIndex === target.image) {
                if (current[position]?.type === 'image') {
                  settled.set(`${seq}:${originalIndex}`, { messageSeq: seq, imageIndex: originalIndex })
                }
                found = true
                break
              }
              visibleIndex += 1
            }
            originalIndex += 1
          }
        }
        if (!found) throw new Error('image pressure target is not a visible image')
      }
      if (settled.size > 0) session.append('image/offload', { targets: [...settled.values()] })
      messages = refresh()
      return deepFreeze(messages)
    },
  }
}
