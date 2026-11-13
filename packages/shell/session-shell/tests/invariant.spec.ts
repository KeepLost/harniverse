/**
 * Session-shell stream invariants: every committed `session-shell/change`
 * carries an entry id (or a legacy family), both at mount-time replay and at
 * live append.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as SessionShellInvariant from '@deepseek-ai/dsh-session-shell/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SessionShellInvariant)
  return ctx
}

describe('session-shell stream invariants', () => {
  it('accepts an entry change and ignores unrelated events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ss-invariant-valid'))
    expect(() => {
      session.append('session-shell/change', { entry: 'my-zsh' })
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('seeds the fold from sessions that existed before the companion mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('ss-invariant-seeded'))
    session.append('session-shell/change', { family: 'bash' } as never)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionShellInvariant)
    expect(session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('accepts a legacy family payload and rejects a shapeless one before committing', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ss-invariant-legacy'))
    expect(() => {
      session.append('session-shell/change', { family: 'pwsh' } as never)
    }).not.toThrow()
    await ctx.fiber.dispose()
    const rejected = await setup()
    const target = rejected.sessions.create(SessionId('ss-invariant-invalid'))
    expect(() => {
      target.append('session-shell/change', { shell: 7 } as never)
    }).toThrow(InvariantError)
    expect(target.events.filter(event => event.type === 'session-shell/change')).toHaveLength(0)
    await rejected.fiber.dispose()
  })
})
