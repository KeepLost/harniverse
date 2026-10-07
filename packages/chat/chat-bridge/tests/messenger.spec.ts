/** Messenger: cards with text fallback, settlement, and failure handling against stub adapters. */

import { describe, expect, it } from 'vitest'
import { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import { Messenger } from '../src/messenger.ts'

const TARGET = { platform: 'fake', botId: 'fake-bot', route: { kind: 'direct', chatId: '1' } } as const

function messenger(adapter?: FakeChatAdapter): { messenger: Messenger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    messenger: new Messenger(
      { get: () => adapter },
      { info: () => undefined, warn: message => warnings.push(message) },
      () => Promise.resolve(),
    ),
  }
}

describe('Messenger.card', () => {
  it('returns nothing for a bot that is not registered', async () => {
    const { messenger: m } = messenger()
    expect(await m.card(TARGET, 'approval', 'body', [])).toBeUndefined()
  })

  it('uses an interaction card when buttons exist and plain text otherwise', async () => {
    const adapter = new FakeChatAdapter()
    const { messenger: m } = messenger(adapter)
    expect((await m.card(TARGET, 'approval', 'body', [{ id: 'a', label: 'A' }]))?.plain).toBe(false)
    expect((await m.card(TARGET, 'approval', 'body', []))?.plain).toBe(true)
    const noButtons = new FakeChatAdapter({ capabilities: { interactionButtons: false } })
    expect((await messenger(noButtons).messenger.card(TARGET, 'approval', 'body', [{ id: 'a', label: 'A' }]))?.plain).toBe(true)
    const noMethod = new FakeChatAdapter()
    Object.defineProperty(noMethod, 'sendInteraction', { value: undefined })
    expect((await messenger(noMethod).messenger.card(TARGET, 'approval', 'body', [{ id: 'a', label: 'A' }]))?.plain).toBe(true)
  })

  it('logs and returns nothing when delivery fails', async () => {
    const adapter = new FakeChatAdapter()
    adapter.failNext('interaction', new Error('nope'))
    const { messenger: m, warnings } = messenger(adapter)
    expect(await m.card(TARGET, 'question', 'body', [{ id: 'a', label: 'A' }])).toBeUndefined()
    expect(warnings).toEqual(['card to fake:fake-bot failed'])
  })
})

describe('Messenger.settle', () => {
  it('settles interaction cards, edits plain cards, and leaves cards it cannot touch', async () => {
    const adapter = new FakeChatAdapter()
    const { messenger: m } = messenger(adapter)
    const interactive = await m.card(TARGET, 'approval', 'body', [{ id: 'a', label: 'A' }])
    const plain = await m.card(TARGET, 'approval', 'body', [])
    await m.settle([interactive!, plain!], 'answered', 'Done.')
    expect(adapter.transcript.slice(-2).map(entry => entry.kind)).toEqual(['settle', 'edit'])
  })

  it('skips a missing adapter, a plain card without edit, and logs a failed settlement', async () => {
    const adapter = new FakeChatAdapter()
    const { messenger: m, warnings } = messenger(adapter)
    const plain = await m.card(TARGET, 'approval', 'body', [])
    const interactive = await m.card(TARGET, 'approval', 'body', [{ id: 'a', label: 'A' }])
    Object.defineProperty(adapter, 'edit', { value: undefined })
    await m.settle([plain!], 'answered', 'x')
    adapter.failNext('settle', new Error('settle broke'))
    await m.settle([interactive!], 'expired', 'x')
    expect(warnings).toEqual(['settling a card on fake:fake-bot failed'])
    await messenger().messenger.settle([plain!], 'answered', 'x')
  })
})
