/**
 * The settings domain base plugin's own mounting behavior: it stands up
 * `ctx.settingsScope` for every feature that owns a preference row, and the
 * service retires with its fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, SettingsScopeBinder } from '../src/client/index.ts'

/** Boot the browser half over the required transport services. */
function bench() {
  const ctx = new Context()
  ctx.provide('connection', {
    api: { settings: { describe: vi.fn() } },
    authentication: {
      getSnapshot: () => ({ kind: 'bypass' as const }),
      subscribe: () => () => {},
      validate: () => true,
    },
  } as never)
  new TestRemote(ctx)
  return { ctx, fiber: ctx.plugin({ inject: [...inject], apply }) }
}

describe('settings domain base plugin', () => {
  it('mounts the scope service under settingsScope', async () => {
    const { ctx, fiber } = bench()
    await fiber.await()
    expect(ctx.get('settingsScope')).toBeInstanceOf(SettingsScopeBinder)
  })

  it('fiber disposal retires the service', async () => {
    const { ctx, fiber } = bench()
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('settingsScope')).toBeUndefined()
  })
})
