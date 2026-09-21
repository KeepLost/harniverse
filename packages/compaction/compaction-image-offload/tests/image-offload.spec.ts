// Durable projection behavior: the image/offload interpreter stubs exactly
// the targeted images inside Session.deriveMessages, composes across
// consecutive decisions, and refuses malformed or non-durable payloads while
// tolerating windowed and shadowed targets.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createMessage, createToolResultMessage, createUserMessage, CallId, deepFreeze } from '@deepseek-ai/dsh-llm'
import { OFFLOADED_IMAGE_STUB_TEXT } from '@deepseek-ai/dsh-image-offload-policy'
import {
  SESSION_FORMAT_VERSION,
  SessionStore,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type { SessionMessageProjectionContext } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '../src/projection.ts'
import { imageCarrier, stubEventImages } from '../src/project-message.ts'

function image(id: string): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(id),
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: `${id}.png`,
    },
  }
}

function userImages(...blocks: ContentBlock[]): UserMessage {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

/** A session carrying the image/offload projection, seeded per test. */
function projectedSession(): Session {
  return Session.create(SessionId('image-offload'), undefined, undefined, [imageOffloadProjection])
}


function offloadEvent(seq: number, targets: unknown): SessionEvent<'image/offload'> {
  return { type: 'image/offload', seq, time: seq, data: targets } as SessionEvent<'image/offload'>
}

/** Call the interpreter directly against an explicit composing context. */
function project(
  event: SessionEvent<'image/offload'>,
  context: Partial<SessionMessageProjectionContext>,
): ReadonlyMap<number, Message> {
  return imageOffloadProjection.project(event, {
    nodes: context.nodes ?? [],
    eventAt: context.eventAt ?? (() => undefined),
    messages: context.messages ?? new Map(),
  })
}

describe('image/offload message projection', () => {
  it('stubs the targeted image and preserves positions and identity', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a'), image('b'), { type: 'text', text: 'tail' }), { surfaceOp: 'append' })
    expect(s.deriveMessages()[0]?.content.map(block => block.type)).toEqual(['image', 'image', 'text'])

    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    const derived = s.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.content).toHaveLength(3)
    expect(derived[0]?.content[0]).toEqual({ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT })
    expect(derived[0]?.content[1]?.type).toBe('image')
    expect(derived[0]?.content[2]).toEqual({ type: 'text', text: 'tail' })
    expect(Object.isFrozen(derived[0])).toBe(true)
  })

  it('composes consecutive decisions because indexes count the durable base', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a'), image('b')), { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 1 }] })
    expect(s.deriveMessages()[0]?.content.map(block => block.type)).toEqual(['image', 'text'])

    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    expect(s.deriveMessages()[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
    ])
  })

  it('stubs images nested in tool results without shifting the result block', () => {
    const s = projectedSession()
    s.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [image('nested')],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    const derived = s.deriveMessages()
    expect(derived).toHaveLength(1)
    const [first, ...rest] = derived[0]!.content
    expect(first?.type).toBe('tool-result')
    if (first?.type !== 'tool-result') return
    expect(first.content).toEqual([{ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT }])
    expect(rest).toHaveLength(0)
  })

  it('keeps the replacement visible when a later compaction shadows the target', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    s.append('user/message', userImages({ type: 'text', text: 'replacement' }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    const derived = s.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.content).toEqual([{ type: 'text', text: 'replacement' }])
  })

  it('replays the projection history after an unrelated surface replacement', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    s.append('user/message', userImages({ type: 'text', text: 'x' }), { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    expect(s.deriveMessages().map(message => message.content[0])).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
      { type: 'text', text: 'x' },
    ])

    s.append('user/message', userImages({ type: 'text', text: 'y' }), {
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    })
    expect(s.deriveMessages().map(message => message.content[0])).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
      { type: 'text', text: 'y' },
    ])
  })

  it('retains the shadowed stub override without surfacing it after a later replacement', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    expect(s.deriveMessages()[0]?.content[0]?.type).toBe('image')
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    expect(s.deriveMessages()[0]?.content[0]?.type).toBe('text')
    s.append('user/message', userImages({ type: 'text', text: 'replacement' }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    })
    const derived = s.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.content).toEqual([{ type: 'text', text: 'replacement' }])
  })

  it('keeps originals for display consumers reading the event directly', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    const event = s.events[0]!
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    s.deriveMessages()
    expect(s.deriveEventMessage(event)?.content[0]?.type).toBe('image')
  })

  it('applies every target of one decision regardless of input order', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a'), image('b')), { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 1 }, { messageSeq: 0, imageIndex: 0 }] })
    expect(s.deriveMessages()[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
    ])
  })

  it('skips null-deriving nodes when rebuilding the composed history', () => {
    const s = projectedSession()
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    const derived = s.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.content[0]).toEqual({ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT })
  })

  it('derives an unprojected session identically when no projection is registered', () => {
    const s = Session.create(SessionId('plain'))
    s.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    s.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    expect(s.deriveMessages()[0]?.content[0]?.type).toBe('image')
  })

  it('tolerates a windowed target whose event is outside the resident log', () => {
    const event = offloadEvent(5, { targets: [{ messageSeq: 1, imageIndex: 0 }] })
    const updates = project(event, { eventAt: () => undefined })
    expect(updates.size).toBe(0)
  })

  it('skips a target whose current message is not on the composing surface', () => {
    const source = {
      type: 'user/message',
      seq: 1,
      time: 1,
      data: userImages(image('a')),
    } as SessionEvent
    const event = offloadEvent(5, { targets: [{ messageSeq: 1, imageIndex: 0 }] })
    const updates = project(event, { eventAt: () => source, messages: new Map() })
    expect(updates.size).toBe(0)
  })

  it.each([
    ['non-object data', null, /data must be an object/],
    ['array data', [], /data must be an object/],
    ['missing targets', {}, /nonempty targets array/],
    ['empty targets', { targets: [] }, /nonempty targets array/],
    ['non-array targets', { targets: 42 }, /nonempty targets array/],
    ['non-object target', { targets: [42] }, /each target must be an object/],
    ['null target', { targets: [null] }, /each target must be an object/],
    ['fractional messageSeq', { targets: [{ messageSeq: 0.5, imageIndex: 0 }] }, /messageSeq and imageIndex/],
    ['negative imageIndex', { targets: [{ messageSeq: 0, imageIndex: -1 }] }, /messageSeq and imageIndex/],
    ['string messageSeq', { targets: [{ messageSeq: '0', imageIndex: 0 }] }, /messageSeq and imageIndex/],
    ['duplicate pair', { targets: [{ messageSeq: 1, imageIndex: 0 }, { messageSeq: 1, imageIndex: 0 }] }, /duplicate target 1:0/],
  ])('rejects a malformed payload (%s)', (_label, data, message) => {
    const event = offloadEvent(5, data)
    expect(() => project(event, {})).toThrow(message)
  })

  it('rejects a target referencing its own or a later event', () => {
    expect(() => project(offloadEvent(3, { targets: [{ messageSeq: 3, imageIndex: 0 }] }), {}))
      .toThrow(/must reference an earlier event/)
  })

  it('rejects a target on an event kind that carries no images', () => {
    const assistant = {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {},
    } as SessionEvent
    const event = offloadEvent(5, { targets: [{ messageSeq: 1, imageIndex: 0 }] })
    expect(() => project(event, { eventAt: () => assistant })).toThrow(/must be user\/message or tool\/result/)
  })

  it('rejects an image index beyond the carrying event\'s images', () => {
    const source = {
      type: 'user/message',
      seq: 1,
      time: 1,
      data: userImages(image('a')),
    } as SessionEvent
    const event = offloadEvent(5, { targets: [{ messageSeq: 1, imageIndex: 1 }] })
    expect(() => project(event, { eventAt: () => source })).toThrow(/image index 1 does not exist on event 1/)
  })

  it('counts no images on a malformed empty tool result', () => {
    const source = {
      type: 'tool/result',
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, message: { role: 'tool', content: [] } },
    } as SessionEvent
    const event = offloadEvent(5, { targets: [{ messageSeq: 1, imageIndex: 0 }] })
    expect(() => project(event, { eventAt: () => source })).toThrow(/image index 0 does not exist on event 1/)
  })
})

describe('SessionStore message-projection registration', () => {
  it('replays pre-window decisions for retained surface nodes, including after another replacement', () => {
    const source = projectedSession()
    source.append('user/message', userImages(image('retained')), { surfaceOp: 'append' })
    source.append('user/message', userImages({ type: 'text', text: 'old text' }), { surfaceOp: 'append' })
    source.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    const boundary = source.seq
    const surface = { nodes: [...source.surface.nodes], replaceGeneration: source.surface.replaceGeneration }
    source.append('user/message', userImages({ type: 'text', text: 'summary' }), {
      surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1],
    })
    const events = source.events
    const restored = Session.fromRestore(source.id, structuredClone(events.slice(boundary)), structuredClone(source.header), {
      firstSeq: boundary, eventAt: seq => events[seq],
    }, surface, [imageOffloadProjection])
    expect(restored.deriveMessages()).toEqual(source.deriveMessages())
    expect(restored.projectedMessageAt(0)?.content).toEqual([{ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT }])
    expect(restored.projectedMessageAt(1)).toBeUndefined()
    restored.append('user/message', userImages({ type: 'text', text: 'new summary' }), {
      surfaceOp: { op: 'replace', start: boundary, end: boundary }, sourceEventSeqs: [boundary],
    })
    expect(restored.projectedMessageAt(0)?.content[0]?.type).toBe('text')
    expect(restored.eventAt(0)?.type).toBe('user/message')
    expect(restored.deriveEventMessage(restored.eventAt(0)!)?.content[0]?.type).toBe('image')
  })

  it('does not skip an invalid durable decision on a second derivation', () => {
    const source = projectedSession()
    source.append('user/message', userImages(image('a')), { surfaceOp: 'append' })
    source.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 2 }] })
    expect(() => source.deriveMessages()).toThrow(/does not exist/)
    expect(() => source.deriveMessages()).toThrow(/does not exist/)
  })

  it('rejects a duplicate projection type until its registration is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const dispose = ctx.sessions.registerMessageProjection(imageOffloadProjection)
    expect(() => ctx.sessions.registerMessageProjection(imageOffloadProjection))
      .toThrow('session message projection "image/offload" is already registered')
    dispose()
    expect(() => ctx.sessions.registerMessageProjection(imageOffloadProjection)).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('projects restored persistence seeds through the registered projection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.registerMessageProjection(imageOffloadProjection)
    const id = SessionId('restored-offload')
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1 }
    const session = ctx.sessions.prepare(id, {
      seed: [
        { type: 'user/message', seq: 0, time: 0, data: userImages(image('r')), surfaceOp: 'append' },
        { type: 'image/offload', seq: 1, time: 1, data: { targets: [{ messageSeq: 0, imageIndex: 0 }] } },
      ] as SessionEvent[],
      meta: structuredClone(meta),
      seedSource: 'persistence',
    })
    expect(session.deriveMessages()[0]?.content[0]).toEqual({ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT })
    await ctx.fiber.dispose()
  })
})

describe('stubEventImages and imageCarrier', () => {
  const carrierEvent = {
    type: 'user/message',
    seq: 2,
    time: 2,
    data: userImages({ type: 'text', text: 'hi' }, image('a')),
  } as SessionEvent

  it('returns the top-level content for user messages and nested for tool results', () => {
    expect(imageCarrier(carrierEvent)).toBe((carrierEvent as SessionEvent<'user/message'>).data.content)
    const toolEvent = {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId('c'), content: [image('b')], isError: false }),
      },
    } as SessionEvent<'tool/result'>
    expect(imageCarrier(toolEvent)).toBe(toolEvent.data.message.content[0].content)
    expect(imageCarrier({ type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } })).toBeUndefined()
  })

  it('returns the same message when no index is requested', () => {
    const message = userImages(image('a'))
    expect(stubEventImages(carrierEvent, message, [])).toBe(message)
  })

  it('throws when the event carries no image blocks at all', () => {
    const textEvent = {
      type: 'turn/end',
      seq: 2,
      time: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent
    expect(() => stubEventImages(textEvent, userImages(image('a')), [0])).toThrow(/carries no image blocks/)
  })

  it('throws when a requested image index does not exist', () => {
    expect(() => stubEventImages(carrierEvent, userImages(image('a')), [1])).toThrow(/image index 1 does not exist/)
  })

  it('throws when the same image is offloaded twice from one base', () => {
    const original = userImages({ type: 'text', text: 'hi' }, image('a'))
    const stubbed = stubEventImages(carrierEvent, original, [0])
    expect(() => stubEventImages(carrierEvent, stubbed, [0])).toThrow(/already offloaded/)
  })

  it('returns the same message when a tool result requests no indexes', () => {
    const toolEvent = {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId('c'), content: [image('b')], isError: false }),
      },
    } as SessionEvent<'tool/result'>
    const message = toolEvent.data.message
    expect(stubEventImages(toolEvent, message, [])).toBe(message)
  })

  it('throws when a tool/result message lost its result block', () => {
    const toolEvent = {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId('c'), content: [image('b')], isError: false }),
      },
    } as SessionEvent
    const malformed = deepFreeze({ ...userImages(image('x')) }) as Message
    expect(() => stubEventImages(toolEvent, malformed, [0])).toThrow(/no tool-result block to stub/)
  })
})
