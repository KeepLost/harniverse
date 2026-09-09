import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resetCheckpointContent, resetCheckpointSource } from '../src/checkpoint.ts'
import { ResetId } from '../src/brand.ts'

/** One user/message surface event text for compact log building. */
function userEvent(session: Session, turn: number, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  void turn
}

/** Build one session whose log carries a mid-log reset checkpoint pair. */
function checkpointedSession(): Session {
  const ctx = new Context()
  void new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId('checkpoint-window'))
  session.append('turn/start', { turn: 1 })
  userEvent(session, 1, 'before one')
  userEvent(session, 1, 'before two')
  const nodes = new SurfaceManager([...session.events]).nodes
  const resetId = ResetId('window-proof')
  const anchor = session.append('reset/checkpoint', { resetId, turn: null })
  const marker = session.append('user/message', createUserMessage({
    content: resetCheckpointContent(),
    source: resetCheckpointSource(resetId),
  }), {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
    sourceEventSeqs: [anchor.seq, ...nodes],
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  userEvent(session, 2, 'after one')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  void marker
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
    const fullMessages = full.nodes.map(seq => bySeq.get(seq)!)
      .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    const windowMessages = windowed.nodes.map(seq => bySeq.get(seq)!)
      .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(windowMessages).toEqual(fullMessages)
    // The pre-reset work left the surface: only the marker and post-reset
    // messages remain, in both folds.
    const texts = windowMessages.map(event => event.type === 'user/message'
      ? event.data.content[0]!.type === 'text' ? event.data.content[0]!.text : ''
      : '')
    expect(texts.some(text => text.startsWith('This is an automatically generated context reset'))).toBe(true)
    expect(texts).not.toContain('before one')
    expect(texts).toContain('after one')
  })

  it('a window that omits the anchor pair is not assumed equivalent', () => {
    const session = checkpointedSession()
    const events = [...session.events]
    const anchorIndex = events.findIndex(event => event.type === 'reset/checkpoint')
    // A window that starts AFTER the marker folds the same tail nodes, but it
    // loses the anchor provenance the invariant and resume checks rely on —
    // documented as a non-boundary: coordinator resume must cut AT the anchor.
    const late = new SurfaceManager(events.slice(anchorIndex + 2), events[anchorIndex + 2]!.seq)
    expect(late.nodes.length).toBeGreaterThan(0)
    expect(late.nodes).not.toContain(events[0]!.seq)
  })
})
