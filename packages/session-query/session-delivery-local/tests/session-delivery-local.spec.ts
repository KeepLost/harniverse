import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import LocalSessionDelivery from '../src/index.ts'

function agent(id: string, origin: 'user' | 'subagent', followup = vi.fn()): Agent {
  return {
    id: SessionId(id),
    session: { header: { origin } },
    followup,
  } as unknown as Agent
}

function request(sender: Agent, targetSessionId: string) {
  return {
    sender,
    targetSessionId: SessionId(targetSessionId),
    content: [{ type: 'text' as const, text: 'continue' }],
    signal: new AbortController().signal,
  }
}

describe('LocalSessionDelivery', () => {
  it('delivers ordinary session messages through the target Agent inbox', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('ordinary', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : target } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    const receipt = await delivery.deliver(request(sender, 'ordinary'))

    expect(receipt.accepted).toBe(true)
    expect(target.followup).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'session-relay', form: 'relay', senderSessionId: sender.id },
    }))
  })

  it('delegates subagent authorization and cold recovery to SubagentRuntime', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('child', 'subagent')
    const followup = vi.fn().mockResolvedValue('child-message')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : target } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('subagents', { followup } as never)
    const delivery = new LocalSessionDelivery(ctx)

    const deliveryRequest = request(sender, 'child')
    const receipt = await delivery.deliver(deliveryRequest)

    expect(receipt).toEqual({ accepted: true, messageId: 'child-message' })
    expect(followup).toHaveBeenCalledWith(sender, target.id, deliveryRequest.content, {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: sender.id },
      signal: deliveryRequest.signal,
    })
    expect(target.followup).not.toHaveBeenCalled()
  })
})
