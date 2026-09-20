import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as PresentInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(PresentInvariant)
  return ctx
}

function event(data: unknown): SessionEvent {
  return { type: 'deliverables/presented', seq: 0, time: 0, data } as SessionEvent
}

const VALID = {
  turn: 1,
  callId: 'call-1',
  files: [{ path: 'a.txt', description: 'answer' }, { path: 'b.txt' }],
}

describe('present delivery invariants', () => {
  it('accepts a coherent durable declaration', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(VALID)) }).not.toThrow()
  })

  it.each([
    ['not an object', null, /must be an object/],
    ['turn zero', { ...VALID, turn: 0 }, /turn must be a positive integer/],
    ['turn fractional', { ...VALID, turn: 1.5 }, /turn must be a positive integer/],
    ['turn string', { ...VALID, turn: '1' }, /turn must be a positive integer/],
    ['callId empty', { ...VALID, callId: '' }, /callId must be a non-empty string/],
    ['callId number', { ...VALID, callId: 42 }, /callId must be a non-empty string/],
    ['files missing', { turn: 1, callId: 'call-1' }, /files must be a non-empty array/],
    ['files empty', { ...VALID, files: [] }, /files must be a non-empty array/],
    ['entry null', { ...VALID, files: [null] }, /entries must be objects/],
    ['entry number', { ...VALID, files: [42] }, /entries must be objects/],
    ['entry array', { ...VALID, files: [['a']] }, /entries must be objects/],
    ['path blank', { ...VALID, files: [{ path: '   ' }] }, /path must be a non-empty string/],
    ['path number', { ...VALID, files: [{ path: 42 }] }, /path must be a non-empty string/],
    ['description number', { ...VALID, files: [{ path: 'a.txt', description: 7 }] }, /description must be a string when present/],
  ])('rejects an incoherent durable declaration (%s)', async (_label, data, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(data)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects an invalid existing declaration on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('deliverables/presented', {
      turn: 1,
      callId: CallId('call-1'),
      files: [{ path: '' }],
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(PresentInvariant).then(() => undefined)).rejects.toThrow(/path must be a non-empty string/)
  })
})
