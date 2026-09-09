import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as invariant from '@deepseek-ai/dsh-context-reset/invariant'
import { resetCheckpointContent, resetCheckpointSource } from '@deepseek-ai/dsh-context-reset'
import { ResetId } from '@deepseek-ai/dsh-context-reset'

type SessionListener = (session: Session, event: unknown) => void

/** Collect the companion's session listener with the invariant service stubbed. */
function install(): { listener: SessionListener; fail: ReturnType<typeof vi.fn> } {
  const listeners: SessionListener[] = []
  const fail = vi.fn(() => { throw new Error('invariant failure') })
  const register = vi.fn().mockImplementation((_name: string, installer: (ctx: Context, fail: () => never) => void) => {
    const ctx = {
      on: (event: string, listener: SessionListener) => {
        if (event === 'session/event') listeners.push(listener)
      },
    } as never as Context
    installer(ctx, fail)
    return () => {}
  })
  void invariant.apply({ invariants: { register } } as never)
  if (listeners.length !== 1) throw new Error('companion did not register one session listener')
  return { listener: listeners[0]!, fail }
}

/** A live session under a real store so appends publish session events. */
function liveSession(name: string): Session {
  const ctx = new Context()
  void new SessionStore(ctx)
  return ctx.sessions.create(SessionId(name))
}

/** Replay every appended event through the captured listener. */
function replay(listener: SessionListener, session: Session): void {
  for (const event of session.events) listener(session, event)
}

describe('context-reset invariant companion', () => {
  it('registers and accepts a correlated anchor and marker pair', () => {
    const { listener, fail } = install()
    expect(invariant.name).toBe('context-reset-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    const session = liveSession('reset-invariant-ok')
    const resetId = ResetId('invariant-ok')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('reset/checkpoint', { resetId, turn: null })
    session.append('user/message', createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(resetId),
    }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [1, 0],
    })
    replay(listener, session)
    expect(fail).not.toHaveBeenCalled()
  })

  it('fails a marker without its preceding anchor', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-orphan')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(ResetId('invariant-orphan')),
    }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    })
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith('reset marker without a preceding reset/checkpoint anchor')
  })

  it('fails a reset marker with no preceding checkpoint anchor', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-orphan')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(ResetId('orphan')),
    }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    })
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith('reset marker without a preceding reset/checkpoint anchor')
  })

  it('rejects malformed reset-marker provenance shapes', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-malformed')
    session.append('reset/checkpoint', { resetId: ResetId('malformed'), turn: null })
    for (const source of [{ kind: 'user' }, { kind: 'plugin', plugin: 'other', resetId: 'x' }, { kind: 'plugin', plugin: 'reset', resetId: 7 }]) {
      session.append('user/message', createUserMessage({
        content: resetCheckpointContent(),
        source: source as never,
      }), { surfaceOp: 'append' })
    }
    // None of the malformed shapes read as a reset marker, so the first one
    // trips the anchor-gap assertion.
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith(expect.stringContaining('not immediately followed'))
  })

  it('fails a reset-source marker that is not a replacement surface event', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-non-replacement')
    session.append('reset/checkpoint', { resetId: ResetId('invariant-flat'), turn: null })
    session.append('user/message', createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(ResetId('invariant-flat')),
    }), { surfaceOp: 'append' })
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith('reset marker must be a replacement surface event')
  })

  it('fails an anchor followed by a foreign event before its marker', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-gap')
    session.append('reset/checkpoint', { resetId: ResetId('invariant-gap'), turn: null })
    session.append('turn/start', { turn: 1 })
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith('reset/checkpoint at seq 0 is not immediately followed by its marker')
  })

  it('fails a marker whose anchor identity does not match', () => {
    const { listener, fail } = install()
    const session = liveSession('reset-invariant-mismatch')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('reset/checkpoint', { resetId: ResetId('invariant-other'), turn: null })
    session.append('user/message', createUserMessage({
      content: resetCheckpointContent(),
      source: resetCheckpointSource(ResetId('invariant-mismatch')),
    }), {
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [1, 0],
    })
    expect(() => {
      replay(listener, session)
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledWith('reset marker at seq 2 must immediately follow its reset/checkpoint anchor')
  })
})
