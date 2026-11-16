/**
 * Tuple-array `Session.append(inputs)` contract: whole-batch validation before
 * mutation, sequences assigned after payload snapshots, sparse-member rejection
 * by index, one publication envelope per batch (observers see the complete
 * committed log), contained reentrancy, and detach deferred to the last member.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventInput } from '@deepseek-ai/dsh-session'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('multiple Session appends', () => {
  it('rejects sparse arrays before changing the log or surface', () => {
    const session = Session.create(SessionId('sparse-append'))
    const inputs = new Array<SessionEventInput>(3)
    inputs[0] = ['turn/start', { turn: 1 }]
    inputs[2] = ['user/message', message('last'), { surfaceOp: 'append' }]
    expect(() => session.append(inputs)).toThrow(/empty member at index 1/)
    expect(session.seq).toBe(0)
    expect(session.surface.nodes).toEqual([])
  })

  it('reads only surface metadata from event options', () => {
    const session = Session.create(SessionId('options-append'))
    const old = session.append('user/message', message('old'), { surfaceOp: 'append' })
    const next = message('new')
    const inputs: SessionEventInput[] = [['user/message', next, old]]
    const events = session.append(inputs)
    expect(events[0]?.data).toEqual(next)
    expect(session.deriveMessages()).toEqual([old.data, next])
  })

  it('leaves the log unchanged for empty input and accepts a single array member', () => {
    const session = Session.create(SessionId('empty-append'))
    expect(session.append([])).toEqual([])
    expect(session.seq).toBe(0)
    const events = session.append([['turn/start', { turn: 1 }]])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn/start', seq: 0, data: { turn: 1 } })
  })

  it('accepts both call forms through an append wrapper', () => {
    const session = Session.create(SessionId('wrapped-append'))
    const append = new Proxy(session.append.bind(session), {
      apply: (target, receiver, args): unknown => Reflect.apply(target, receiver, args),
    })
    session.append = append
    expect(session.append('turn/start', { turn: 1 }).seq).toBe(0)
    expect(session.append([['step/start', { turn: 1, step: 1 }]])).toHaveLength(1)
  })

  it('publishes each member after the complete log and surface are committed', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('observed-append'))
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      if (current !== session) return
      expect(current.currentBatchPublication).toBe(event)
      expect(current.seq).toBe(2)
      expect(current.surface.nodes).toEqual([1])
      expect(current.deriveMessages()).toEqual([messageValue])
      observed.push(event.seq)
    })
    const messageValue = message('visible')
    session.append([
      ['turn/start', { turn: 1 }],
      ['user/message', messageValue, { surfaceOp: 'append' }],
    ])
    expect(observed).toEqual([0, 1])
    expect(session.currentBatchPublication).toBeUndefined()
  })

  it('replaces an earlier member in the same append', () => {
    const session = Session.create(SessionId('replace-append'))
    const nodes = session.surface.nodes
    const replacement = message('replacement')
    session.append([
      ['user/message', message('original'), { surfaceOp: 'append' }],
      ['user/message', replacement, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] }],
    ])
    expect(nodes).toEqual([1])
    expect(session.deriveMessages()).toEqual([replacement])
  })

  it('replaces a committed event from a later batch', () => {
    const session = Session.create(SessionId('replace-committed'))
    session.append([['user/message', message('original'), { surfaceOp: 'append' }]])
    const replacement = message('replacement')
    session.append([
      ['user/message', replacement, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] }],
    ])
    expect(session.surface.nodes).toEqual([1])
    expect(session.deriveMessages()).toEqual([replacement])
  })

  it('validates a committed tool-result rewrite against resident history', () => {
    const session = Session.create(SessionId('toolresult-committed'))
    const original = { turn: 1, step: 1, message: createToolResultMessage({
      callId: CallId('call-1'), content: [{ type: 'text', text: 'result' }], isError: false,
    }) }
    session.append([
      ['turn/start', { turn: 1 }],
      ['tool/result', original, { surfaceOp: 'append' }],
    ])
    const block = original.message.content[0]
    const rewritten = {
      ...original,
      message: freezeMessage({ ...original.message, content: [{ ...block, content: 'edited' }] as unknown as [typeof block] }),
    }
    session.append([
      ['tool/result', rewritten, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] }],
    ])
    expect(session.surface.nodes).toEqual([2])
  })

  it('validates a same-batch tool-result rewrite against the batch member', () => {
    const session = Session.create(SessionId('toolresult-batch'))
    const original = { turn: 1, step: 1, message: createToolResultMessage({
      callId: CallId('call-1'), content: [{ type: 'text', text: 'result' }], isError: false,
    }) }
    const block = original.message.content[0]
    const rewritten = {
      ...original,
      message: freezeMessage({ ...original.message, content: [{ ...block, content: 'edited' }] as unknown as [typeof block] }),
    }
    session.append([
      ['turn/start', { turn: 1 }],
      ['tool/result', original, { surfaceOp: 'append' }],
      ['tool/result', rewritten, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] }],
    ])
    expect(session.surface.nodes).toEqual([2])
  })

  it('rejects non-JSON data before publishing any member', () => {
    const session = Session.create(SessionId('non-json-append'))
    expect(() => session.append([
      ['turn/start', { turn: 1 }],
      ['turn/start', { turn: Number.NaN }],
    ])).toThrow('session batch member 1 ("turn/start") carries non-JSON-serializable data')
    expect(session.seq).toBe(0)
  })

  it('assigns consecutive sequences after a candidate getter appends an event', () => {
    const session = Session.create(SessionId('getter-append'))
    const events = session.append([
      ['turn/start', {
        get turn() {
          session.append('request/context', { provider: 'mock', model: 'mock' })
          return 1
        },
      }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(events.map(event => event.seq)).toEqual([1, 2])
    expect(session.events.map(event => event.type)).toEqual(['request/context', 'turn/start', 'step/start'])
  })

  it('contains a reentrant append while publishing the remaining members', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('reentrant-batch'))
    const observed: number[] = []
    const warnings: string[] = []
    ctx.logger.warn = (warning: unknown) => { warnings.push(String(warning)) }
    ctx.on('session/event', (current, event) => {
      if (current === session && event.seq === 0) {
        session.append('request/context', { provider: 'mock', model: 'mock' })
      }
    })
    ctx.on('session/event', (current, event) => {
      if (current === session) observed.push(event.seq)
    })
    session.append([
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(session.seq).toBe(2)
    expect(observed).toEqual([0, 1])
    expect(warnings).toEqual([expect.stringContaining('session append cannot reenter')])
  })

  it('detaches only after every member has been observed', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(SessionId('detached-append'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      expect(ctx.sessions.get(current.id)).toBe(current)
      detach()
      observed.push(event.seq)
    })
    session.append([
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(observed).toEqual([0, 1])
  })
})
