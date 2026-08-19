/** Local-process ordinary-session delivery provider. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { foldRequestHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionDelivery,
  type SessionDeliveryRequest,
  type SessionDeliveryReceipt,
  type SessionUnloadReceipt,
  type SessionUnloadRequest,
} from '@deepseek-ai/dsh-session-delivery'

/** Deliver to live or persisted ordinary sessions owned by this process. */
export class LocalSessionDelivery extends SessionDelivery {
  static inject = ['agents', 'sessions']

  private readonly resolveAgent

  constructor(ctx: Context) {
    super(ctx)
    const resumes = new Map<SessionId, Promise<Agent>>()
    this.resolveAgent = async (sessionId: SessionId): Promise<Agent> => {
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) {
        if (live.session.header.origin === 'subagent') throw new Error('target is a subagent session; use subagent delivery')
        return live
      }
      if (ctx.sessions.get(sessionId) !== undefined) throw new Error('target session is attached without a live Agent')
      let resume = resumes.get(sessionId)
      if (resume !== undefined) return resume
      resume = (async () => {
        try {
          const persistence = ctx.get('sessionPersistence')
          if (persistence === undefined) throw new Error('session persistence is not configured')
          const listed = (await persistence.list()).find(header => header.id === sessionId)
          if (listed === undefined) throw new Error('target session was not found')
          const inspected = await persistence.inspect(sessionId)
          if (inspected.meta.origin === 'subagent') throw new Error('target is a subagent session; use subagent delivery')
          const presets = ctx.get('agentPresets')
          const presetId = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
          if (presetId !== undefined && presets === undefined) {
            throw new Error('target session preset is unavailable')
          }
          const defaultModel = ctx.get('agentDefaultModel')
          const recordedSelection = foldRequestHeader(inspected.events)?.config
          const resumeSelection = recordedSelection ?? defaultModel?.currentSelection()
          if (resumeSelection === undefined) {
            throw new Error('target session has no recorded model and no deployment default is configured')
          }
          const setup = presets === undefined ? undefined : async (agentCtx: Context) => {
            await presets.mount(agentCtx, presetId)
          }
          return (await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: resumeSelection,
            setup: async (agentCtx) => {
              const agent = agentCtx.agent
              if (agent === undefined) throw new Error('session delivery setup has no scoped Agent')
              const selected: ModelSelectionRef = {
                get current() {
                  const logged = agent.session.requestHeader()?.config
                  if (logged === undefined) return defaultModel?.currentSelection() ?? resumeSelection
                  return {
                    provider: logged.provider,
                    model: logged.model,
                    ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
                  }
                },
                assembled: undefined,
              }
              installModelSelection(agentCtx, selected)
              await setup?.(agentCtx)
            },
          })).agent
        } finally {
          resumes.delete(sessionId)
        }
      })()
      resumes.set(sessionId, resume)
      return resume
    }
  }

  /** Validate caller identity, resolve the target, and accept one follow-up. */
  async deliver(request: SessionDeliveryRequest): Promise<SessionDeliveryReceipt> {
    request.signal.throwIfAborted()
    if (this.ctx.agents.get(request.sender.id) !== request.sender) {
      throw new Error('session delivery requires the exact live sender Agent')
    }
    if (request.targetSessionId === request.sender.id) {
      throw new Error('session delivery cannot target the sender session')
    }
    const target = await this.resolveAgent(request.targetSessionId)
    request.signal.throwIfAborted()
    const message = createUserMessage({
      content: request.content,
      source: { kind: 'session-relay', form: 'relay', senderSessionId: request.sender.id },
    })
    request.signal.throwIfAborted()
    target.followup(message)
    return { accepted: true, messageId: message.id }
  }

  /** Unload one idle ordinary target without discarding queued or owned work. */
  async unload(request: SessionUnloadRequest): Promise<SessionUnloadReceipt> {
    request.signal.throwIfAborted()
    if (this.ctx.agents.get(request.sender.id) !== request.sender) {
      throw new Error('session unload requires the exact live sender Agent')
    }
    if (request.targetSessionId === request.sender.id) {
      throw new Error('session unload cannot target the sender session')
    }
    const target = this.ctx.agents.get(request.targetSessionId)
    if (target === undefined) return { unloaded: false }
    if (target.session.header.origin === 'subagent') {
      throw new Error('target is a subagent session; use subagent lifecycle control')
    }
    const live = this.ctx.agents.list()
    if (live.some(agent => agent !== target && this.ctx.agents.isOwnedBy(target.id, agent))) {
      throw new Error('target session is runtime-owned by another Agent')
    }
    if (live.some(agent => this.ctx.agents.isOwnedBy(agent.id, target))) {
      throw new Error('target session still owns a live child Agent')
    }
    request.signal.throwIfAborted()
    const result = await this.ctx.agents.closeIfIdle(target.id)
    if (result === 'busy') throw new Error('target session is running, under maintenance, or has pending messages')
    if (result === 'not-found') throw new Error('target session detached before unload acquired its lifecycle')
    return { unloaded: true }
  }
}

export default LocalSessionDelivery
