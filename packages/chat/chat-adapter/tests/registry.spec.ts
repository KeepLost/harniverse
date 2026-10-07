/** Registry semantics: mutual exclusion, disposers, lifecycle events, and lookup. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters, { ChatAdapterError, chatAdapterKey, type ChatAdapter } from '../src/index.ts'
import { stubAdapter } from './fixtures/stub-adapter.ts'

async function registry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ChatAdapters)
  return ctx
}

describe('chatAdapters registry', () => {
  it('registers, reads, and removes through the returned disposer', async () => {
    const ctx = await registry()
    const adapter = stubAdapter('telegram', 'bot-1')
    const dispose = ctx.chatAdapters.register(adapter)
    expect(ctx.chatAdapters.get('telegram', 'bot-1')).toBe(adapter)
    expect(ctx.chatAdapters.list()).toEqual([adapter])
    dispose()
    dispose()
    expect(ctx.chatAdapters.get('telegram', 'bot-1')).toBeUndefined()
    expect(ctx.chatAdapters.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a duplicate platform:botId registration and keeps the first owner', async () => {
    const ctx = await registry()
    const first = stubAdapter('telegram', 'bot-1')
    ctx.chatAdapters.register(first)
    expect(() => { ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1')) })
      .toThrow('chatAdapters: telegram:bot-1 is already registered')
    expect(ctx.chatAdapters.get('telegram', 'bot-1')).toBe(first)
    await ctx.fiber.dispose()
  })

  it('distinguishes platforms and bot ids and preserves registration order', async () => {
    const ctx = await registry()
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))
    ctx.chatAdapters.register(stubAdapter('feishu', 'bot-1'))
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-2'))
    expect(ctx.chatAdapters.list().map(entry => chatAdapterKey(entry.platform, entry.botId)))
      .toEqual(['telegram:bot-1', 'feishu:bot-1', 'telegram:bot-2'])
    await ctx.fiber.dispose()
  })

  it('allows re-registration after disposal', async () => {
    const ctx = await registry()
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))()
    const second = stubAdapter('telegram', 'bot-1')
    expect(() => { ctx.chatAdapters.register(second) }).not.toThrow()
    expect(ctx.chatAdapters.get('telegram', 'bot-1')).toBe(second)
    await ctx.fiber.dispose()
  })

  it('emits registered after the entry is readable and unregistered after it is gone', async () => {
    const ctx = await registry()
    const seen: string[] = []
    ctx.on('chat-adapter/registered', (adapter) => {
      seen.push(`registered:${adapter.botId}:${String(ctx.chatAdapters.get(adapter.platform, adapter.botId) === adapter)}`)
    }, { global: true })
    ctx.on('chat-adapter/unregistered', (adapter) => {
      seen.push(`unregistered:${adapter.botId}:${String(ctx.chatAdapters.get(adapter.platform, adapter.botId) === undefined)}`)
    }, { global: true })
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))()
    expect(seen).toEqual(['registered:bot-1:true', 'unregistered:bot-1:true'])
    await ctx.fiber.dispose()
  })

  it('emits no registered event for a rejected duplicate', async () => {
    const ctx = await registry()
    const seen: ChatAdapter[] = []
    ctx.on('chat-adapter/registered', (adapter) => { seen.push(adapter) }, { global: true })
    ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1'))
    expect(() => { ctx.chatAdapters.register(stubAdapter('telegram', 'bot-1')) }).toThrow('already registered')
    expect(seen).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

describe('ChatAdapterError', () => {
  it('carries the classified code, platform-prefixed message, retry hint, and cause', () => {
    const cause = new Error('socket hang up')
    const error = new ChatAdapterError('rate-limited', 'telegram', 'slow down', { retryAfterMs: 3_000, cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('rate-limited')
    expect(error.retryAfterMs).toBe(3_000)
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('chat-adapter(telegram): slow down')
  })

  it('omits the retry hint when none is given', () => {
    const error = new ChatAdapterError('network', 'feishu', 'reset')
    expect(error.retryAfterMs).toBeUndefined()
  })
})
