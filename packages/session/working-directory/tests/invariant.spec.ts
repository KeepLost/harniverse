import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as WorkingDirectoryInvariant from '@deepseek-ai/dsh-working-directory/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(WorkingDirectoryInvariant)
  return ctx
}

describe('working-directory stream invariants', () => {
  it('accepts an absolute change and ignores unrelated events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('wd-invariant-valid'))
    expect(() => {
      session.append('working-directory/change', { cwd: '/tmp/project' })
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('seeds the fold from sessions that existed before the companion mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('wd-invariant-seeded'))
    session.append('working-directory/change', { cwd: '/tmp/before-mount' })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(WorkingDirectoryInvariant)
    expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects a non-absolute change before committing it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('wd-invariant-invalid'))
    expect(() => {
      session.append('working-directory/change', { cwd: 'relative/path' })
    }).toThrow(InvariantError)
    expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
