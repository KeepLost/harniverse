import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply as applyNode } from '../src/index.ts'

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** Boot the browser half over a real slot tree declaring the tab list. */
async function bench(): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  captured: CapturedRegistration[]
  remoteCalls: unknown[][]
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'governor.center.tab': { kind: 'list', scope: 'global' },
    },
  } as never, () => null)
  const remoteCalls: unknown[][] = []
  const verb = (name: string) => async (...args: unknown[]) => {
    remoteCalls.push([name, ...args])
    return { ok: true as const, value: undefined }
  }
  ctx.provide('remote', {
    $on: () => () => {},
    queue: {
      topicList: verb('topicList'),
      topicCreate: verb('topicCreate'),
      topicDelete: verb('topicDelete'),
      publish: verb('publish'),
      messages: verb('messages'),
      subscriptions: verb('subscriptions'),
      subscribe: verb('subscribe'),
      unsubscribe: verb('unsubscribe'),
    },
  } as never)
  ctx.provide('remote.queue', {} as never)
  // The locale plugin binds a settings scope, which reads the connection handle.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('sessions', {})
  const scopeStub = stubSettingsScope()
  ctx.provide('settingsScope', { bind: () => scopeStub.scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const captured: CapturedRegistration[] = []
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: (clientCtx) => {
      const slots = clientCtx.slots as unknown as {
        register: (options: Record<string, unknown>, component: unknown) => () => void
        inject: (name: string, fn: () => unknown) => unknown
      }
      const inner = slots.register.bind(clientCtx.slots)
      slots.register = (options, component) => {
        captured.push({ options, component })
        return inner(options, component)
      }
      apply(clientCtx)
    },
  })
  await fiber.await()
  await new Promise((resolve) => { setTimeout(resolve, 80) })
  return { ctx, fiber, captured, remoteCalls }
}

describe('ui-queue browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.queue'])
  })

  it('registers the panel tab, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()

    expect(ctx.slots.entries('governor.center.tab').map(entry => entry.options.id)).toContain('queue')
    await fiber.dispose()
    expect(ctx.slots.entries('governor.center.tab')).toEqual([])
  })

  it('labels the tab through its own locale and orders after resources', async () => {
    const { captured } = await bench()
    const tab = captured.find(({ options }) => options['id'] === 'queue')
    expect(tab).toBeDefined()
    expect(tab!.options['order']).toBe(20)
    const label = tab!.options['label'] as () => string
    expect(label()).toBe('消息队列')
  })

  it('binds the tab verbs to the queue Remote', async () => {
    const { captured, remoteCalls } = await bench()
    const tab = captured.find(({ options }) => options['id'] === 'queue')
    const injectFace = tab!.options['inject'] as () => Record<string, (...args: unknown[]) => Promise<unknown> & { pollMs: number }>
    const face = injectFace() as unknown as {
      topicList: () => Promise<unknown>
      topicCreate: (...args: unknown[]) => Promise<unknown>
      topicDelete: (...args: unknown[]) => Promise<unknown>
      publish: (...args: unknown[]) => Promise<unknown>
      messages: (...args: unknown[]) => Promise<unknown>
      subscriptions: (...args: unknown[]) => Promise<unknown>
      subscribe: (...args: unknown[]) => Promise<unknown>
      unsubscribe: (...args: unknown[]) => Promise<unknown>
      pollMs: number
    }
    await face.topicList()
    await face.topicCreate('t', null)
    await face.topicDelete('t')
    await face.publish('t', { x: 1 }, {}, null, 'panel')
    await face.messages('t', 0, 100, false)
    await face.subscriptions('t', null)
    await face.subscribe('s', 't')
    await face.unsubscribe('s', 't')
    expect(face.pollMs).toBe(5_000)
    expect(remoteCalls.map(call => call[0])).toEqual([
      'topicList', 'topicCreate', 'topicDelete', 'publish', 'messages', 'subscriptions', 'subscribe', 'unsubscribe',
    ])
  })

  it('runs the empty node-half apply without touching the context', () => {
    expect(applyNode).not.toThrow()
  })

  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin({ name: 'queue-panel-invariant', inject: ['invariants'], apply: applyInvariant })
    await fiber.await()
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
