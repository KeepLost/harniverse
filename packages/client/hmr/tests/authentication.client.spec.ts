// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { BrowserAuthentication } from '@deepseek-ai/dsh-client-authentication'
import { afterEach, expect, it, vi } from 'vitest'
import * as Hmr from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('checks authentication after stream failure and closes the carrier on terminal state or disposal', async () => {
  const source = new EventTarget()
  const close = vi.fn()
  vi.stubGlobal('EventSource', class {
    addEventListener = source.addEventListener.bind(source)
    close = close
  })
  const ctx = new Context()
  const authentication = new BrowserAuthentication({ mode: 'bypass' })
  const check = vi.spyOn(authentication, 'check')
  ctx.provide('clientAuthentication', authentication)
  ctx.provide('modules', {})
  ctx.provide('loader', {})
  const fiber = ctx.plugin(Hmr)
  await fiber.await()
  source.dispatchEvent(new Event('error'))
  await vi.waitFor(() => { expect(check).toHaveBeenCalledOnce() })
  expect(close).not.toHaveBeenCalled()
  authentication.requireRefresh()
  expect(close).toHaveBeenCalledOnce()
  await fiber.dispose()
  expect(close).toHaveBeenCalledTimes(2)
  expect(check.mock.calls[0]![0]!.aborted).toBe(true)
  await authentication.stop()
  expect(close).toHaveBeenCalledTimes(2)
  await ctx.fiber.dispose()
})
