import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as OffloadInvariant from '../src/invariant.ts'

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(OffloadInvariant)
  const session = ctx.sessions.create()
  session.append('user/message', createUserMessage({
    content: [
      { type: 'image', attachment: { attachmentId: AttachmentId('a'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      { type: 'image', attachment: { attachmentId: AttachmentId('b'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { ctx, session }
}

function offload(seq: number, data: unknown): SessionEvent {
  return { type: 'image/offload', seq, time: seq, data } as SessionEvent
}

describe('image-offload durable invariants', () => {
  it('accepts a coherent durable decision', async () => {
    const bench = await setup()
    expect(() => {
      bench.ctx.emit('session/event', bench.session, offload(1, { targets: [{ messageSeq: 0, imageIndex: 0 }, { messageSeq: 0, imageIndex: 1 }] }))
    }).not.toThrow()
  })

  it.each([
    ['missing targets', 1, {}, /nonempty targets array/],
    ['empty targets', 1, { targets: [] }, /nonempty targets array/],
    ['non-array targets', 1, { targets: 42 }, /nonempty targets array/],
    ['fractional messageSeq', 1, { targets: [{ messageSeq: 0.5, imageIndex: 0 }] }, /non-negative safe-integer messageSeq and imageIndex/],
    ['string imageIndex', 1, { targets: [{ messageSeq: 0, imageIndex: '0' }] }, /non-negative safe-integer messageSeq and imageIndex/],
    ['negative messageSeq', 1, { targets: [{ messageSeq: -1, imageIndex: 0 }] }, /non-negative safe-integer messageSeq and imageIndex/],
    ['duplicate pair', 1, { targets: [{ messageSeq: 0, imageIndex: 0 }, { messageSeq: 0, imageIndex: 0 }] }, /duplicate target 0:0/],
    ['self reference', 1, { targets: [{ messageSeq: 1, imageIndex: 0 }] }, /must reference an earlier event/],
    ['unknown event kind', 2, { targets: [{ messageSeq: 1, imageIndex: 0 }] }, /must reference a user\/message or tool\/result event/],
    ['image index out of bounds', 1, { targets: [{ messageSeq: 0, imageIndex: 2 }] }, /image index 2 does not exist on event 0/],
  ])('rejects an incoherent durable decision (%s)', async (_label, seq, data, message) => {
    const bench = await setup()
    expect(() => { bench.ctx.emit('session/event', bench.session, offload(seq, data)) }).toThrow(message)
  })

  it('treats a malformed empty tool result as carrying no images', async () => {
    const bench = await setup()
    bench.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', content: [] },
    } as never, { surfaceOp: 'append' })
    expect(() => {
      bench.ctx.emit('session/event', bench.session, offload(2, { targets: [{ messageSeq: 1, imageIndex: 0 }] }))
    }).toThrow(/image index 0 does not exist on event 1/)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const bench = await setup()
    expect(() => {
      bench.ctx.emit('tools/change')
      bench.ctx.emit('session/event', bench.session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      } as SessionEvent)
    }).not.toThrow()
  })

  it('rejects an invalid existing decision on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'no images' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('image/offload', { targets: [{ messageSeq: 0, imageIndex: 0 }] })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(OffloadInvariant).then(() => undefined)).rejects.toThrow(/image index 0 does not exist on event 0/)
  })
})
