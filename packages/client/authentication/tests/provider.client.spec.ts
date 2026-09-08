// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { expect, it, vi } from 'vitest'
import { BrowserAuthentication } from '../src/browser.ts'
import Provider from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

it('adopts the same bootstrap instance and stops it with the plugin owner', async () => {
  const ctx = new Context()
  const authentication = new BrowserAuthentication({ mode: 'bypass' })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(Invariant).await()
  const fiber = ctx.plugin(Provider, authentication)
  await fiber.await()
  const service = ctx.clientAuthentication
  expect(service.getSnapshot()).toBe(authentication.getSnapshot())
  const unsubscribe = service.subscribe(() => {})
  await service.ready()
  await service.check()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('accepted')))
  expect(await (await service.fetch('/api/example')).text()).toBe('accepted')
  vi.unstubAllGlobals()
  unsubscribe()
  service.requireRefresh()
  expect(authentication.getSnapshot().phase).toBe('required')
  await fiber.dispose()
  expect(authentication.getSnapshot().phase).toBe('stopped')
  expect(ctx.get('clientAuthentication')).toBeUndefined()
  await ctx.fiber.dispose()
})
