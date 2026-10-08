/** Registry semantics: mutual exclusion, disposers, lifecycle events, and lookup. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters, { ChatAdapterError, chatAdapterKey, type ChatAdapter, type ChatPlatformDescriptor } from '../src/index.ts'
import { stubAdapter } from './fixtures/stub-adapter.ts'
import { stubDescriptor } from './fixtures/stub-descriptor.ts'

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

describe('chatAdapters platform registry', () => {
  it('registers, reads, and removes a descriptor through the returned disposer', async () => {
    const ctx = await registry()
    const descriptor = stubDescriptor('telegram')
    const dispose = ctx.chatAdapters.registerPlatform(descriptor)
    expect(ctx.chatAdapters.platform('telegram')).toBe(descriptor)
    expect(ctx.chatAdapters.platforms()).toEqual([descriptor])
    dispose()
    dispose()
    expect(ctx.chatAdapters.platform('telegram')).toBeUndefined()
    expect(ctx.chatAdapters.platforms()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a duplicate platform id and keeps the first owner', async () => {
    const ctx = await registry()
    const first = stubDescriptor('telegram')
    ctx.chatAdapters.registerPlatform(first)
    expect(() => { ctx.chatAdapters.registerPlatform(stubDescriptor('telegram')) })
      .toThrow('chatAdapters: platform telegram is already registered')
    expect(ctx.chatAdapters.platform('telegram')).toBe(first)
    await ctx.fiber.dispose()
  })

  it('preserves registration order and keeps platforms independent of adapters', async () => {
    const ctx = await registry()
    ctx.chatAdapters.registerPlatform(stubDescriptor('telegram'))
    ctx.chatAdapters.registerPlatform(stubDescriptor('feishu'))
    expect(ctx.chatAdapters.platforms().map(entry => entry.platform)).toEqual(['telegram', 'feishu'])
    expect(ctx.chatAdapters.platform('slack')).toBeUndefined()
    expect(ctx.chatAdapters.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('allows re-registration after disposal', async () => {
    const ctx = await registry()
    ctx.chatAdapters.registerPlatform(stubDescriptor('telegram'))()
    const second = stubDescriptor('telegram')
    expect(() => { ctx.chatAdapters.registerPlatform(second) }).not.toThrow()
    expect(ctx.chatAdapters.platform('telegram')).toBe(second)
    await ctx.fiber.dispose()
  })

  it('emits registered after the entry is readable and unregistered after it is gone', async () => {
    const ctx = await registry()
    const seen: string[] = []
    ctx.on('chat-platform/registered', (descriptor) => {
      seen.push(`registered:${descriptor.platform}:${String(ctx.chatAdapters.platform(descriptor.platform) === descriptor)}`)
    }, { global: true })
    ctx.on('chat-platform/unregistered', (descriptor) => {
      seen.push(`unregistered:${descriptor.platform}:${String(ctx.chatAdapters.platform(descriptor.platform) === undefined)}`)
    }, { global: true })
    ctx.chatAdapters.registerPlatform(stubDescriptor('telegram'))()
    expect(seen).toEqual(['registered:telegram:true', 'unregistered:telegram:true'])
    await ctx.fiber.dispose()
  })

  it('emits no registered event for a rejected duplicate', async () => {
    const ctx = await registry()
    const seen: ChatPlatformDescriptor[] = []
    ctx.on('chat-platform/registered', (descriptor) => { seen.push(descriptor) }, { global: true })
    ctx.chatAdapters.registerPlatform(stubDescriptor('telegram'))
    expect(() => { ctx.chatAdapters.registerPlatform(stubDescriptor('telegram')) }).toThrow('already registered')
    expect(seen).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('removes the descriptor when its registering fiber is disposed', async () => {
    const ctx = await registry()
    const fiber = await ctx.plugin({
      inject: ['chatAdapters'],
      apply(scope: Context) { scope.effect(() => scope.chatAdapters.registerPlatform(stubDescriptor('telegram'))) },
    })
    expect(ctx.chatAdapters.platform('telegram')).toBeDefined()
    await fiber.dispose()
    expect(ctx.chatAdapters.platform('telegram')).toBeUndefined()
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
