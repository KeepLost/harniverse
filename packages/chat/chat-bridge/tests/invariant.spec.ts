/** Serial-queue invariant: a conversation never starts a task while another runs. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BridgeInvariant from '../src/invariant.ts'
import { boot, cleanup, member } from './helpers.ts'

afterEach(cleanup)

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(BridgeInvariant)
  return ctx
}

describe('chat-bridge invariants', () => {
  it('accepts non-overlapping tasks per key', async () => {
    const ctx = await setup()
    ctx.emit('chat-bridge/dispatch', { phase: 'start', key: 'a' })
    ctx.emit('chat-bridge/dispatch', { phase: 'start', key: 'b' })
    ctx.emit('chat-bridge/dispatch', { phase: 'end', key: 'a' })
    ctx.emit('chat-bridge/dispatch', { phase: 'start', key: 'a' })
    ctx.emit('chat-bridge/dispatch', { phase: 'end', key: 'a' })
    ctx.emit('chat-bridge/dispatch', { phase: 'end', key: 'b' })
    await ctx.fiber.dispose()
  })

  it('rejects a start while the key is running and an end that never started', async () => {
    const ctx = await setup()
    ctx.emit('chat-bridge/dispatch', { phase: 'start', key: 'a' })
    expect(() => { ctx.emit('chat-bridge/dispatch', { phase: 'start', key: 'a' }) }).toThrow('while another was running')
    expect(() => { ctx.emit('chat-bridge/dispatch', { phase: 'end', key: 'ghost' }) }).toThrow('was not running')
    await ctx.fiber.dispose()
  })

  it('holds for real bridge traffic', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.ctx.plugin(InvariantRegistry)
    await h.ctx.plugin(BridgeInvariant)
    await Promise.all([h.say('200', '/whoami'), h.say('200', '/help'), h.say('100', '/whoami')])
    expect(h.adapter.transcript).toHaveLength(3)
  })
})
