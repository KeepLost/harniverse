import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SupervisionInvariant from '../src/invariant.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-supervision'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  ctx.provide('supervision', { allowsHumanInteraction: () => true })
  await ctx.plugin(SupervisionInvariant)
  return ctx
}

/** A mode event carrying an arbitrary value, bypassing the typed append surface. */
const modeEvent = (mode: string, seq: number): SessionEvent => ({
  type: 'supervision/mode',
  seq,
  time: 0,
  data: { mode },
} as unknown as SessionEvent)

describe('supervision invariant companion', () => {
  it('accepts every supported mode appended to a live session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => session.append('supervision/mode', { mode: 'supervised' })).not.toThrow()
    expect(() => session.append('supervision/mode', { mode: 'unsupervised' })).not.toThrow()
  })

  it('rejects an unknown mode dispatched as a session event', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => {
      ctx.emit('internal/dispatch', 'emit', 'session/event', [session, modeEvent('autopilot', 1)], null)
    }).toThrow(/supervision\/mode contains unknown mode "autopilot"/)
  })

  it('ignores dispatches that are not session events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => {
      ctx.emit('internal/dispatch', 'emit', 'session/created', [session, modeEvent('autopilot', 1)], null)
    }).not.toThrow()
  })

  it('ignores session events of other types', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const other = { type: 'session/title', seq: 1, time: 0, data: { title: 'x' } } as unknown as SessionEvent

    expect(() => {
      ctx.emit('internal/dispatch', 'emit', 'session/event', [session, other], null)
    }).not.toThrow()
  })

  it('validates events already stored on a session at registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    ctx.provide('supervision', { allowsHumanInteraction: () => true })
    const session = ctx.sessions.create()
    session.append('supervision/mode', { mode: 'supervised' })

    await expect(ctx.plugin(SupervisionInvariant)).resolves.toBeDefined()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = await setup()

    expect(() => {
      ctx.invariants.register(PACKAGE_NAME, () => {})
    }).toThrow(/already registered/)
  })
})
