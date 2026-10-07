/** Fake adapter behavior: deterministic inbound delivery and outbound transcription. */

import { describe, expect, it } from 'vitest'
import { ChatAdapterError, type ChatInbound, type ChatRoute } from '@deepseek-ai/dsh-chat-adapter'
import { FAKE_CAPABILITIES, FakeChatAdapter, renderTranscript } from '../src/index.ts'

function message(controlText: string, chatId = '42'): ChatInbound {
  return {
    type: 'message',
    messageId: `m-${controlText}`,
    route: { kind: 'direct', chatId },
    sender: { userId: chatId, isBot: false },
    addressed: true,
    text: controlText,
    controlText,
    attachments: [],
    platformTime: 1_000,
  }
}

/** Start a run loop and return the adapter, its controller, and the loop promise. */
function started(
  adapter: FakeChatAdapter,
  accept: (event: ChatInbound) => Promise<void> = () => Promise.resolve(),
): { controller: AbortController; loop: Promise<void> } {
  const controller = new AbortController()
  return { controller, loop: adapter.run({ accept }, controller.signal) }
}

describe('FakeChatAdapter run loop', () => {
  it('holds the sink until the abort signal fires', async () => {
    const adapter = new FakeChatAdapter()
    const { controller, loop } = started(adapter)
    expect(adapter.running).toBe(true)
    controller.abort()
    await loop
    expect(adapter.running).toBe(false)
  })

  it('returns immediately for a signal that is already aborted', async () => {
    const adapter = new FakeChatAdapter()
    const controller = new AbortController()
    controller.abort()
    await adapter.run({ accept: () => Promise.resolve() }, controller.signal)
    expect(adapter.running).toBe(false)
  })

  it('ends the loop on stop and tolerates repeated stops', async () => {
    const adapter = new FakeChatAdapter()
    const { loop } = started(adapter)
    await adapter.stop()
    await adapter.stop()
    await loop
    expect(adapter.running).toBe(false)
    await adapter.stop()
  })

  it('can run again after a loop ended', async () => {
    const adapter = new FakeChatAdapter()
    const first = started(adapter)
    first.controller.abort()
    await first.loop
    const seen: string[] = []
    const second = started(adapter, (event) => {
      if (event.type === 'message') seen.push(event.controlText)
      return Promise.resolve()
    })
    await adapter.enqueue(message('again'))
    second.controller.abort()
    await second.loop
    expect(seen).toEqual(['again'])
  })
})

describe('FakeChatAdapter inbound', () => {
  it('serializes delivery so enqueue resolves after sink acceptance', async () => {
    const adapter = new FakeChatAdapter()
    const order: string[] = []
    const { controller, loop } = started(adapter, async (event) => {
      if (event.type !== 'message') return
      order.push(`start:${event.controlText}`)
      await new Promise(resolve => setTimeout(resolve, 1))
      order.push(`end:${event.controlText}`)
    })
    const first = adapter.enqueue(message('a'))
    const second = adapter.enqueue(message('b'))
    await Promise.all([first, second])
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
    controller.abort()
    await loop
  })

  it('propagates a sink rejection to that enqueue only', async () => {
    const adapter = new FakeChatAdapter()
    let calls = 0
    const { controller, loop } = started(adapter, () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('sink broke')) : Promise.resolve()
    })
    await expect(adapter.enqueue(message('a'))).rejects.toThrow('sink broke')
    await expect(adapter.enqueue(message('b'))).resolves.toBeUndefined()
    controller.abort()
    await loop
  })

  it('rejects enqueue without a running loop', async () => {
    const adapter = new FakeChatAdapter()
    await expect(adapter.enqueue(message('x'))).rejects.toThrow('requires a running adapter')
  })
})

describe('FakeChatAdapter outbound', () => {
  it('records every outbound call shape in order with distinct message ids', async () => {
    const adapter = new FakeChatAdapter({ platform: 'fake', botId: 'b1' })
    const route: ChatRoute = { kind: 'direct', chatId: '42' }
    const sent = await adapter.send(route, { text: 'hello' })
    await adapter.edit(sent, { text: 'hello!' })
    await adapter.recall(sent)
    const card = await adapter.sendInteraction(route, { kind: 'approval', body: 'run bash?', actions: [{ id: 'allow', label: 'Approve' }] })
    await adapter.settleInteraction(card, 'answered')
    await adapter.sendFile(route, { filePath: '/tmp/a.txt', fileName: 'a.txt', bytes: 3 })
    await adapter.setTyping(route)
    expect(adapter.transcript.map(entry => entry.kind)).toEqual(['send', 'edit', 'recall', 'interaction', 'settle', 'file', 'typing'])
    const ids = adapter.transcript.flatMap(entry => entry.kind === 'send' || entry.kind === 'interaction' || entry.kind === 'file' ? [entry.ref.messageId] : [])
    expect(new Set(ids).size).toBe(3)
  })

  it('fails exactly the next call of a targeted operation', async () => {
    const adapter = new FakeChatAdapter()
    const route: ChatRoute = { kind: 'direct', chatId: '42' }
    adapter.failNext('send', new ChatAdapterError('send-failed', 'fake', 'boom'))
    await expect(adapter.send(route, { text: 'x' })).rejects.toMatchObject({ code: 'send-failed' })
    await expect(adapter.send(route, { text: 'y' })).resolves.toMatchObject({ route })
    expect(adapter.transcript).toHaveLength(1)
    adapter.failNext('edit', new Error('edit boom'))
    adapter.failNext('recall', new Error('recall boom'))
    adapter.failNext('interaction', new Error('interaction boom'))
    adapter.failNext('settle', new Error('settle boom'))
    adapter.failNext('file', new Error('file boom'))
    adapter.failNext('typing', new Error('typing boom'))
    const ref = { messageId: 'x', route }
    await expect(adapter.edit(ref, { text: 'e' })).rejects.toThrow('edit boom')
    await expect(adapter.recall(ref)).rejects.toThrow('recall boom')
    await expect(adapter.sendInteraction(route, { kind: 'question', body: 'q', actions: [] })).rejects.toThrow('interaction boom')
    await expect(adapter.settleInteraction(ref, 'expired')).rejects.toThrow('settle boom')
    await expect(adapter.sendFile(route, { filePath: '/a', fileName: 'a', bytes: 1 })).rejects.toThrow('file boom')
    await expect(adapter.setTyping(route)).rejects.toThrow('typing boom')
    expect(adapter.transcript).toHaveLength(1)
  })

  it('serves programmable attachment sources within the caller cap', async () => {
    const adapter = new FakeChatAdapter()
    adapter.attachments.set('att-1', { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
    const fetched = await adapter.fetchAttachment({ attachmentId: 'att-1' }, 8, AbortSignal.timeout(1_000))
    expect(fetched.mediaType).toBe('image/png')
    expect([...new Uint8Array(await new Response(fetched.stream).arrayBuffer())]).toEqual([1, 2, 3])
    await expect(adapter.fetchAttachment({ attachmentId: 'att-1' }, 2, AbortSignal.timeout(1_000))).rejects.toThrow('exceeds')
    await expect(adapter.fetchAttachment({ attachmentId: 'missing' }, 8, AbortSignal.timeout(1_000))).rejects.toThrow('no attachment source')
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    expect(() => adapter.fetchAttachment({ attachmentId: 'att-1' }, 8, aborted.signal)).toThrow('cancelled')
  })

  it('derives direct routes and honors explicit refusals', () => {
    const adapter = new FakeChatAdapter()
    expect(adapter.directRoute('42')).toEqual({ kind: 'direct', chatId: '42' })
    adapter.directRoutes.set('42', undefined)
    expect(adapter.directRoute('42')).toBeUndefined()
    adapter.directRoutes.set('43', { kind: 'direct', chatId: 'dm-43' })
    expect(adapter.directRoute('43')).toEqual({ kind: 'direct', chatId: 'dm-43' })
  })

  it('applies capability overrides over the capable defaults', () => {
    expect(new FakeChatAdapter().capabilities).toEqual(FAKE_CAPABILITIES)
    const degraded = new FakeChatAdapter({ capabilities: { interactionButtons: false, editOutbound: false } })
    expect(degraded.capabilities).toEqual({ ...FAKE_CAPABILITIES, interactionButtons: false, editOutbound: false })
  })
})

describe('renderTranscript', () => {
  it('renders every call shape deterministically', async () => {
    const adapter = new FakeChatAdapter()
    const route: ChatRoute = { kind: 'group', chatId: 'g1', threadId: 't9' }
    const sent = await adapter.send(route, { text: 'hi "there"' })
    await adapter.edit(sent, { text: 'hi' })
    await adapter.recall(sent)
    const card = await adapter.sendInteraction({ kind: 'direct', chatId: '1' }, {
      kind: 'approval', body: 'ok?', actions: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }],
    })
    await adapter.settleInteraction(card, 'superseded')
    await adapter.sendFile(route, { filePath: '/x/report.txt', fileName: 'report.txt', bytes: 12 })
    await adapter.setTyping({ kind: 'direct', chatId: '1' })
    expect(renderTranscript(adapter.transcript)).toBe([
      '- send fake-1 → group:g1#t9: "hi \\"there\\""',
      '- edit fake-1: "hi"',
      '- recall fake-1',
      '- interaction fake-2 → direct:1 [approval] "ok?" actions=y:Yes|n:No',
      '- settle fake-2: superseded',
      '- file fake-3 → group:g1#t9: report.txt (12 bytes)',
      '- typing → direct:1',
      '',
    ].join('\n'))
  })
})
