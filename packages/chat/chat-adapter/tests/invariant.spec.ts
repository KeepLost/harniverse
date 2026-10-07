/** Registry lifecycle invariant: live-key uniqueness and readable-before-registered ordering. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import ChatAdapters from '../src/index.ts'
import * as ChatAdapterInvariant from '../src/invariant.ts'
import { stubAdapter } from './fixtures/stub-adapter.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ChatAdapters)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ChatAdapterInvariant)
  return ctx
}

describe('chat-adapter invariants', () => {
  it('accepts register and dispose cycles', async () => {
    const ctx = await setup()
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))()
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))
    await ctx.fiber.dispose()
  })

  it('rejects a registered event repeated for a live key', async () => {
    const ctx = await setup()
    const adapter = stubAdapter('telegram', 'bot-1')
    ctx.chatAdapters.register(adapter)
    expect(() => { ctx.emit('chat-adapter/registered', adapter) }).toThrow('repeated live key')
    await ctx.fiber.dispose()
  })

  it('rejects a registered event for an adapter the registry cannot read', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('chat-adapter/registered', stubAdapter('telegram', 'ghost')) }).toThrow('was readable')
    await ctx.fiber.dispose()
  })

  it('rejects an unregistered event for an unknown adapter', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('chat-adapter/unregistered', stubAdapter('telegram', 'ghost')) }).toThrow('unknown adapter')
    await ctx.fiber.dispose()
  })

  it('rejects an unregistered event that fires while the key is still readable', async () => {
    const ctx = await setup()
    const adapter = stubAdapter('telegram', 'bot-1')
    ctx.chatAdapters.register(adapter)
    expect(() => { ctx.emit('chat-adapter/unregistered', adapter) }).toThrow('still readable')
    await ctx.fiber.dispose()
  })
})
