import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import * as ImageOffloadInvariant from '@deepseek-ai/dsh-image-offload-policy/invariant'

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ImageOffloadInvariant)
  return { ctx, session: ctx.sessions.create() }
}

function carrierData(imageCount: number): UserMessage {
  return {
    id: 'carrier',
    role: 'user',
    content: Array.from({ length: imageCount }, () => ({ type: 'image', attachment: {} })),
    source: { kind: 'direct' },
  } as unknown as UserMessage
}

/** Append one image-carrying user message and return its assigned seq. */
async function appendCarrier(session: Session, imageCount: number): Promise<number> {
  session.append('user/message', carrierData(imageCount), { surfaceOp: 'append' })
  return session.events[session.events.length - 1]!.seq
}

describe('image-offload-policy invariants', () => {
  it('accepts an offload whose targets name real image blocks', async () => {
    const { session } = await setup()
    const carrierSeq = await appendCarrier(session, 2)
    expect(() => session.append('image/offload', { targets: [{ messageSeq: carrierSeq, imageIndex: 1 }] })).not.toThrow()
  })

  it('rejects a target naming no earlier event or no image block', async () => {
    const { session } = await setup()
    const carrierSeq = await appendCarrier(session, 1)
    expect(() => session.append('image/offload', { targets: [{ messageSeq: carrierSeq + 40, imageIndex: 0 }] }))
      .toThrow(new InvariantError('@deepseek-ai/dsh-image-offload-policy', `image/offload targets seq ${carrierSeq + 40}, which no earlier event carries`))
    expect(() => session.append('image/offload', { targets: [{ messageSeq: carrierSeq, imageIndex: 1 }] }))
      .toThrow(new InvariantError('@deepseek-ai/dsh-image-offload-policy', `image/offload target (${carrierSeq}, 1) names no image block of its carrier event`))
  })

  it('rejects duplicate targets within one event and re-settling an earlier offload', async () => {
    const { session } = await setup()
    const carrierSeq = await appendCarrier(session, 2)
    expect(() => session.append('image/offload', {
      targets: [{ messageSeq: carrierSeq, imageIndex: 0 }, { messageSeq: carrierSeq, imageIndex: 0 }],
    })).toThrow(new InvariantError('@deepseek-ai/dsh-image-offload-policy', `image/offload repeats target (${carrierSeq}, 0) in one event`))
    session.append('image/offload', { targets: [{ messageSeq: carrierSeq, imageIndex: 0 }] })
    expect(() => session.append('image/offload', { targets: [{ messageSeq: carrierSeq, imageIndex: 0 }] }))
      .toThrow(new InvariantError('@deepseek-ai/dsh-image-offload-policy', `image/offload re-settles target (${carrierSeq}, 0) an earlier offload already recorded`))
  })

  it('ignores unrelated appends', async () => {
    const { session } = await setup()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })
})
