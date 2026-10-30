/**
 * apply wiring on a real cordis Context + SlotRegistry: QuestionComposer
 * registered as the `question` entry of the conversation-declared composer
 * slot with ZERO business face (data and verbs ride the dispatched carrier),
 * the answered-batch Definition registered on the conversation event
 * registry, the keyed Chat renderer behind conversation.chat.node,
 * declaration-aware activation, and fiber-teardown unregistration. Component
 * and domain-face behavior is covered props-direct in question-composer.spec.tsx;
 * no renderer machinery here.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/conversation/event-registry.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { QuestionReplyView } from '../src/client/QuestionReplyView.tsx'
import { answeredQuestionDefinition } from '../src/client/question-reply.ts'
import { apply, inject } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  const conversationEvents = new ConversationEventRegistry(ctx)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  // The composer and chat-node slots exist only while their declaring
  // entries are live.
  slots.register(
    {
      name: 'root',
      children: {
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    } as never,
    () => null,
  )
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots, conversationEvents }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'conversationEvents'])
  })

  it('waits until a live entry declares the composer slot', async () => {
    const ctx = new Context()
    new ConversationEventRegistry(ctx)
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.composer')).toHaveLength(0)
    ctx.slots.register(
      { name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never,
      () => null,
    )
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('registers the question entry: routing selector, no inject face', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    // The whole behavior surface rides the matched carrier: no business face;
    // copy rides the standard locale seat.
    expect(entry.inject).toBeUndefined()
    expect(entry.locale).toBe('question')
    // The selector narrows the chain currency: question wait in → that wait; none → null.
    const select = entry.select as (owner: { interactions: readonly { kind: string }[] }) => unknown
    const question = { kind: 'question' }
    expect(select({ interactions: [{ kind: 'approval' }, question] })).toBe(question)
    expect(select({ interactions: [{ kind: 'approval' }] })).toBeNull()
    expect(select({ interactions: [] })).toBeNull()
  })

  it('registers the answered-batch Definition and the keyed Chat renderer', async () => {
    const { ctx, slots, conversationEvents } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(conversationEvents.entries()).toContain(answeredQuestionDefinition)
    const renderer = slots.entries('conversation.chat.node')[0]!
    expect(renderer.component).toBe(QuestionReplyView)
    expect(renderer.locale).toBe('question')
    expect(renderer.options.key).toBe('question-reply')
  })

  it('teardown unregisters the slot entries and the Definition', async () => {
    const { ctx, slots, conversationEvents } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.composer')).toHaveLength(1)
    expect(conversationEvents.entries()).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.composer')).toHaveLength(0)
    expect(slots.entries('conversation.chat.node')).toHaveLength(0)
    expect(conversationEvents.entries()).toHaveLength(0)
  })
})
