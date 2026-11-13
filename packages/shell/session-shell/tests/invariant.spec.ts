/**
 * Session-shell stream invariants: every committed `session-shell/change`
 * carries one of the two families, both at mount-time replay and at live
 * append.
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
  it('accepts a family change and ignores unrelated events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ss-invariant-valid'))
    expect(() => {
      session.append('session-shell/change', { family: 'pwsh' })
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('seeds the fold from sessions that existed before the companion mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('ss-invariant-seeded'))
    session.append('session-shell/change', { family: 'bash' })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionShellInvariant)
    expect(session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects an unknown family before committing it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ss-invariant-invalid'))
    expect(() => {
      session.append('session-shell/change', { family: 'zsh' } as never)
    }).toThrow(InvariantError)
    expect(session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
