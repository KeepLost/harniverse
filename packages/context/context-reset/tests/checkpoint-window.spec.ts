import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resetCheckpointContent, resetCheckpointSource } from '../src/checkpoint.ts'
import { ResetId } from '../src/brand.ts'

/** One user/message surface event for compact log building. */
function userEvent(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Build one session whose log carries a mid-log reset checkpoint pair. */
function checkpointedSession(withRequestState = false): Session {
  const ctx = new Context()
  void new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId('checkpoint-window'))
  if (withRequestState) {
    session.append('request/header', { header: { config: { provider: 'mock', model: 'model' } }, reason: 'initial' })
    session.append('request/context', { provider: 'mock', model: 'model' })
  }
  session.append('turn/start', { turn: 1 })
  userEvent(session, 'before one')
  userEvent(session, 'before two')
  const nodes = new SurfaceManager([...session.events]).nodes
  const resetId = ResetId('window-proof')
  const anchor = session.append('reset/checkpoint', { resetId, turn: null })
  session.append('user/message', createUserMessage({
    content: resetCheckpointContent(),
    source: resetCheckpointSource(resetId),
  }), {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
    sourceEventSeqs: [anchor.seq, ...nodes],
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  userEvent(session, 'after one')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return session
}

describe('reset checkpoint window equivalence', () => {
  it('a SurfaceManager seeded from the anchor folds the identical surface', () => {
    const session = checkpointedSession()
    const events = [...session.events]
    const anchorIndex = events.findIndex(event => event.type === 'reset/checkpoint')
    expect(anchorIndex).toBeGreaterThan(0)
    const window = events.slice(anchorIndex)
    const baseSeq = window[0]!.seq

    const full = new SurfaceManager(events, 0)
    const windowed = new SurfaceManager(window, baseSeq)
    // Cutting at the marker alone folds the same surface too: the historical
    // replace is accepted against the empty window state.
    const fromMarker = new SurfaceManager(events.slice(anchorIndex + 1), events[anchorIndex + 1]!.seq)

    expect(windowed.nodes).toEqual(full.nodes)
    expect(fromMarker.nodes).toEqual(full.nodes)

    // The derived message stream over each fold is payload-identical: every
    // node seq resolves to the same event in both scopes. This is the
    // deriveMessages equivalence kernel a windowed cold resume will rely on.
    const bySeq = new Map(events.map(event => [event.seq, event]))
    for (const seq of windowed.nodes) {
      expect(bySeq.get(seq)).toBeDefined()
    }
    const messagesOf = (nodes: readonly number[]) => nodes.map(seq => bySeq.get(seq)!)
      .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(messagesOf(windowed.nodes)).toEqual(messagesOf(full.nodes))
    // The pre-reset work left the surface: only the marker and post-reset
    // messages remain, in every fold.
    const texts = messagesOf(windowed.nodes).map(event => event.type === 'user/message'
      ? event.data.content[0]!.type === 'text' ? event.data.content[0]!.text : ''
      : '')
    expect(texts.some(text => text.startsWith('This is an automatically generated context reset'))).toBe(true)
    expect(texts).not.toContain('before one')
    expect(texts).toContain('after one')
  })

  it('a window that omits the marker pair is not assumed equivalent', () => {
    const session = checkpointedSession()
    const events = [...session.events]
    const anchorIndex = events.findIndex(event => event.type === 'reset/checkpoint')
    // A window that starts after the marker still folds, but it loses the
    // anchor provenance the invariant and resume checks rely on — the
    // coordinator must cut AT the anchor, documented as the non-boundary.
    const late = new SurfaceManager(events.slice(anchorIndex + 2), events[anchorIndex + 2]!.seq)
    expect(late.nodes.length).toBeGreaterThan(0)
    expect(late.nodes).not.toContain(events[0]!.seq)
  })
})

/** Storage metadata shape the restore path accepts. */
function restoreHeader(id: SessionId): SessionHeader {
  return { id, version: SESSION_FORMAT_VERSION, createdAt: 1 }
}

describe('windowed Session restore equivalence', () => {
  it('derives the identical message history as a full-log restore', () => {
    const source = checkpointedSession()
    const events = [...source.events]
    const markerIndex = events.findIndex(event => event.type === 'user/message'
      && (event.data.source as { plugin?: string } | undefined)?.plugin === 'reset')
    expect(markerIndex).toBeGreaterThan(0)

    const full = Session.fromRestore(SessionId('window-full'), events, restoreHeader(SessionId('window-full')))
    const windowStart = markerIndex - 1 // the reset anchor
    const window = events.slice(windowStart)
    const windowed = Session.fromRestore(SessionId('window-restored'), window, restoreHeader(SessionId('window-restored')))

    expect(windowed.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(windowed.seq).toBe(full.seq)
    expect(windowed.firstLiveSeq).toBe(full.firstLiveSeq)
    expect(windowed.events.length).toBe(full.events.length - windowStart)
    expect(windowed.deriveMessages()).toEqual(full.deriveMessages())

    // The windowed session stays append-contiguous in absolute seq space.
    windowed.append('turn/start', { turn: 3 })
    expect(windowed.events.at(-1)?.seq).toBe(full.events.at(-1)!.seq + 1)
  })

  it('keeps the historical prefix lazy until a full-history consumer asks for it', () => {
    const source = checkpointedSession()
    const events = [...source.events]
    const markerIndex = events.findIndex(event => event.type === 'user/message'
      && (event.data.source as { plugin?: string } | undefined)?.plugin === 'reset')
    const calls: number[] = []
    const windowStart = markerIndex - 1
    const windowed = Session.fromRestore(
      SessionId('window-lazy'),
      events.slice(windowStart),
      restoreHeader(SessionId('window-lazy')),
      { firstSeq: windowStart, eventAt: (seq) => { calls.push(seq); return events[seq] } },
    )

    expect(windowed.deriveMessages()).toEqual(Session.fromRestore(
      SessionId('window-full-lazy'), events, restoreHeader(SessionId('window-full-lazy')),
    ).deriveMessages())
    expect(calls).toEqual([])
    expect(windowed.eventAt(0)?.seq).toBe(0)
    expect(calls).toEqual([0])
    expect(windowed.events).toHaveLength(windowed.seq)
    expect(calls).toEqual(Array.from({ length: windowStart }, (_, seq) => seq))
  })

  it('preserves request state when the checkpoint window starts after its events', () => {
    const source = checkpointedSession(true)
    const events = [...source.events]
    const anchorIndex = events.findIndex(event => event.type === 'reset/checkpoint')
    const windowStart = anchorIndex
    const anchor = events[windowStart]
    if (anchor === undefined) throw new Error('checkpoint anchor missing')
    const full = Session.fromRestore(SessionId('request-state-full'), events, restoreHeader(SessionId('request-state-full')))
    const windowed = Session.fromRestore(
      SessionId('request-state-window'),
      events.slice(windowStart),
      restoreHeader(SessionId('request-state-window')),
      { firstSeq: anchor.seq, eventAt: seq => events[seq] },
    )

    expect(windowed.requestHeader()).toEqual(full.requestHeader())
    expect(windowed.requestContext()).toEqual(full.requestContext())
  })

  it('rejects a windowed seed outside the restore path', () => {
    const source = checkpointedSession()
    const events = [...source.events]
    expect(() => {
      Session.create(SessionId('window-snapshot'), events.slice(1))
    }).toThrow('only a restore may adopt a window')
  })
})
