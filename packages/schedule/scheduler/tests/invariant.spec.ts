import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SchedulerInvariant from '@deepseek-ai/dsh-scheduler/invariant'

/** A real context with the companion installed, so appends validate in place. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SchedulerInvariant)
  return ctx
}

describe('scheduler invariant companion', () => {
  it('registers under its package name with the registry injected', () => {
    expect(SchedulerInvariant.name).toBe('scheduler-invariant')
    expect(SchedulerInvariant.inject).toEqual(['invariants'])
  })

  it('accepts a dispatch that names its own session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('scheduler-invariant-self'))
    expect(() => {
      session.append('schedule/dispatch', {
        scheduleId: 'schedule-a',
        dueAt: 1,
        targetSessionId: session.id,
        turn: null,
      })
    }).not.toThrow()
  })

  it('rejects a dispatch appended to a session other than its target', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('scheduler-invariant-foreign'))
    expect(() => {
      session.append('schedule/dispatch', {
        scheduleId: 'schedule-b',
        dueAt: 1,
        targetSessionId: SessionId('scheduler-invariant-other'),
        turn: null,
      })
    }).toThrow(/names target scheduler-invariant-other inside session scheduler-invariant-foreign/)
  })

  it('ignores every event type it does not own', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('scheduler-invariant-foreign-types'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
  })
})
