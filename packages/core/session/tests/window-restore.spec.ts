import { describe, expect, it } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { CallId, createToolResultMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '../src/index.ts'
import type { SessionEvent, SessionHistorySource } from '../src/types.ts'
import type { SessionMessageProjection } from '../src/surface.ts'

const id = SessionId('window-boundaries')
const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1 }
const tail: SessionEvent[] = [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }]
const first: SessionEvent = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }

function restore(eventAt: SessionHistorySource['eventAt'], nodes: readonly number[] = []): Session {
  return Session.fromRestore(id, tail, header, { firstSeq: 1, eventAt }, { nodes, replaceGeneration: 0 })
}

describe('windowed history boundaries', () => {
  it('requires restoration for a seed that begins after seq zero', () => {
    expect(() => Session.create(id, tail, header)).toThrow('only a restore may adopt a window')
    const session = Session.fromRestore(id, tail, header)
    expect(session.surface.nodes).toEqual([])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.eventsFrom(1).map(event => event.seq)).toEqual([1, 2])
    expect(session.append('turn/start', { turn: 2 }).seq).toBe(3)
    expect(session.deriveMessages()).toEqual([])
  })

  it('refuses a missing historical projection event even when no surface node refers to it', () => {
    const projection: SessionMessageProjection<'request/context'> = {
      type: 'request/context',
      project: () => new Map(),
    }
    const session = Session.fromRestore(id, tail, header,
      { firstSeq: 1, eventAt: () => undefined }, undefined, [projection])
    expect(session.surface.nodes).toEqual([])
    expect(() => session.deriveMessages()).toThrow('has no projection event at seq 0')
    expect(session.eventsFrom(1)).toHaveLength(2)
  })

  it('replays historical plugin projections once and exposes the same frozen message by seq', () => {
    const source = Session.create(id)
    source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }), { surfaceOp: 'append' })
    source.append('request/context', { provider: 'mock', model: 'projected' })
    const boundary = source.seq
    const surface = { nodes: [...source.surface.nodes], replaceGeneration: source.surface.replaceGeneration }
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    let applications = 0
    const projection: SessionMessageProjection<'request/context'> = {
      type: 'request/context',
      project(event, context) {
        applications += 1
        const original = context.messages.get(0)!
        return new Map([[0, freezeMessage({ ...original, content: [{ type: 'text', text: event.data.model }] })]])
      },
    }
    const restored = Session.fromRestore(id, structuredClone(source.events.slice(boundary)), structuredClone(source.header), {
      firstSeq: boundary, eventAt: seq => source.eventAt(seq),
    }, surface, [projection])
    const message = restored.projectedMessageAt(0)
    expect(message?.content).toEqual([{ type: 'text', text: 'projected' }])
    expect(restored.deriveMessages()[0]).toBe(message)
    expect(restored.projectedMessageAt(0)).toBe(message)
    expect(Object.isFrozen(message)).toBe(true)
    expect(applications).toBe(1)
    expect(restored.deriveEventMessage(restored.eventAt(0)!)?.content).toEqual([{ type: 'text', text: 'original' }])
  })

  it('owns every event in a requested snapshot independently of the history resolver', () => {
    let open = true
    const session = restore(() => {
      if (!open) throw new Error('history resolver closed')
      return first
    })
    const events = session.events
    open = false
    expect(events[0]).toEqual(first)
    expect(session.events).toBe(events)
    expect(events[0]).toBe(session.eventAt(0))
  })

  it('releases unreferenced historical payloads and snapshots while the Session remains live', async () => {
    // Each test file owns a fork; expose GC only in this process, without timing sleeps or heap-size assumptions.
    setFlagsFromString('--expose-gc')
    const collect = runInNewContext('gc') as () => void
    const session = restore(() => structuredClone(first))
    const payload = new WeakRef(session.eventAt(0)!)
    const snapshot = new WeakRef(session.events)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await setImmediate()
      collect()
      if (payload.deref() === undefined && snapshot.deref() === undefined) break
    }
    expect(payload.deref()).toBeUndefined()
    expect(snapshot.deref()).toBeUndefined()
    expect(session.eventAt(0)).toEqual(first)
    expect(session.events[0]).toBe(session.eventAt(0))
  })

  it('rejects a resolver whose declared boundary disagrees with the seed', () => {
    expect(() => Session.fromRestore(id, tail, header, { firstSeq: 2, eventAt: () => first }))
      .toThrow('history starts at seq 2, but its seed starts at seq 1')
  })

  it('validates absolute lookup and suffix bounds without consulting the prefix', () => {
    const session = restore(() => { throw new Error('unexpected prefix read') })
    for (const seq of [-1, 0.5, Number.NaN, session.seq]) expect(session.eventAt(seq)).toBeUndefined()
    for (const seq of [-1, 0, 1.5, session.seq + 1]) expect(() => session.eventsFrom(seq)).toThrow(RangeError)
    expect(session.eventsFrom(session.seq)).toEqual([])
    expect(session.eventsFrom(1).map(event => event.seq)).toEqual([1, 2])
    expect(Object.isFrozen(session.eventsFrom(1))).toBe(true)
  })

  it('reports missing historical events instead of silently truncating history or projections', () => {
    const session = restore(() => undefined, [0])
    expect(session.eventAt(0)).toBeUndefined()
    expect(() => session.events[0]).toThrow('has no event at seq 0')
    expect(() => session.requestHeader()).toThrow('has no event at seq 0')
    expect(() => session.deriveMessages()).toThrow('has no surface event at seq 0')
  })

  it.each([
    [{ ...first, seq: 42 }, 'history event has seq 42, expected 0'],
    [{ ...first, data: { turn: Number.NaN } }, 'not losslessly JSON-serializable'],
  ] as const)('rejects an invalid historical event (%j)', (event, message) => {
    const session = restore(() => event)
    expect(() => session.eventAt(0)).toThrow(message)
  })

  it('finds the newest resident request state without expanding the historical prefix', () => {
    const session = restore(() => { throw new Error('unexpected prefix read') })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'old' } }, reason: 'initial' })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'current' } }, reason: 'initial' })
    session.append('request/context', { provider: 'mock', model: 'current' })
    expect(session.requestHeader()?.config).toEqual({ provider: 'mock', model: 'current' })
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'current' })
  })

  it('validates a tool-result rewrite against the original event outside the window', () => {
    const source = Session.create(id)
    const original = source.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('history-call'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('tool/result', original.data, {
      surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0],
    })
    const window = Session.fromRestore(id, source.events.slice(2), header,
      { firstSeq: 2, eventAt: seq => source.eventAt(seq) }, { nodes: [0], replaceGeneration: 0 })
    expect(window.deriveMessages()).toEqual(source.deriveMessages())
  })
})
