import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as ContextResetInvariant from '@deepseek-ai/dsh-context-reset/invariant'
import { ResetId, resetCheckpointContent, resetCheckpointSource } from '@deepseek-ai/dsh-context-reset'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

/**
 * A real context with the companion installed, so every append publishes
 * through the store-owned hook and a violation throws at the append site.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ContextResetInvariant)
  return ctx
}

/** Append an ordinary surface message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append the replacement marker that must follow a reset anchor. */
function appendMarker(session: Session, resetId: string, shadowed: number[]): void {
  session.append('user/message', createUserMessage({
    content: resetCheckpointContent(),
    source: resetCheckpointSource(ResetId(resetId)),
  }), {
    surfaceOp: { op: 'replace', start: shadowed[0]!, end: shadowed.at(-1)! },
    sourceEventSeqs: shadowed,
  })
}

describe('context-reset invariant companion', () => {
  it('registers under its package name with the registry injected', () => {
    expect(ContextResetInvariant.name).toBe('context-reset-invariant')
    expect(ContextResetInvariant.inject).toEqual(['invariants'])
  })

  it('accepts a correlated anchor and marker pair', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reset-invariant-ok'))
    const prior = appendUser(session, 'prior')
    session.append('reset/checkpoint', { resetId: ResetId('invariant-ok'), turn: null })
    expect(() => {
      appendMarker(session, 'invariant-ok', [prior])
    }).not.toThrow()
  })

  it('fails a marker without its preceding anchor', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reset-invariant-orphan'))
    const prior = appendUser(session, 'prior')
    expect(() => {
      appendMarker(session, 'invariant-orphan', [prior])
    }).toThrow(/reset marker without a preceding reset\/checkpoint anchor/)
  })

  it('fails a reset-source marker that is not a replacement surface event', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reset-invariant-non-replacement'))
    session.append('reset/checkpoint', { resetId: ResetId('invariant-flat'), turn: null })
    expect(() => {
      session.append('user/message', createUserMessage({
        content: resetCheckpointContent(),
        source: resetCheckpointSource(ResetId('invariant-flat')),
      }), { surfaceOp: 'append' })
    }).toThrow(/reset marker must be a replacement surface event/)
  })

  it('fails an anchor followed by a foreign event before its marker', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reset-invariant-gap'))
    session.append('reset/checkpoint', { resetId: ResetId('invariant-gap'), turn: null })
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).toThrow(/reset\/checkpoint at seq 0 is not immediately followed by its marker/)
  })

  it('fails a marker whose anchor identity does not match', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reset-invariant-mismatch'))
    const prior = appendUser(session, 'prior')
    session.append('reset/checkpoint', { resetId: ResetId('invariant-other'), turn: null })
    expect(() => {
      appendMarker(session, 'invariant-mismatch', [prior])
    }).toThrow(/reset marker at seq 2 must immediately follow its reset\/checkpoint anchor/)
  })

  it('adopts existing history when installed after the session exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    const session = ctx.sessions.create(SessionId('reset-invariant-late-install'))
    const prior = appendUser(session, 'prior')
    session.append('reset/checkpoint', { resetId: ResetId('late'), turn: null })
    appendMarker(session, 'late', [prior])
    // The companion folds the stored log at install time, so the settled pair
    // leaves no pending anchor and ordinary appends keep flowing.
    await ctx.plugin(ContextResetInvariant)
    expect(() => {
      appendUser(session, 'after install')
    }).not.toThrow()
  })

  it('carries a pending anchor seeded from existing history', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    const session = ctx.sessions.create(SessionId('reset-invariant-late-pending'))
    session.append('reset/checkpoint', { resetId: ResetId('late-pending'), turn: null })
    await ctx.plugin(ContextResetInvariant)
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).toThrow(/reset\/checkpoint at seq 0 is not immediately followed by its marker/)
  })

  it.each([
    ['a plain user source', 'plain-user', { kind: 'user' }],
    ['a foreign plugin source', 'foreign-plugin', { kind: 'plugin', plugin: 'other', resetId: 'x' }],
    ['a non-string resetId', 'numeric-reset-id', { kind: 'plugin', plugin: 'reset', resetId: 7 }],
  ])('does not read %s as a reset marker', async (_label, slug, source) => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId(`reset-invariant-malformed-${slug}`))
    session.append('reset/checkpoint', { resetId: ResetId('malformed'), turn: null })
    // The shape never satisfies the marker guard, so the anchor stays pending
    // and this append trips the gap assertion instead of the marker checks.
    expect(() => {
      session.append('user/message', createUserMessage({
        content: resetCheckpointContent(),
        source: source as never,
      }), { surfaceOp: 'append' })
    }).toThrow(/is not immediately followed by its marker/)
  })
})
