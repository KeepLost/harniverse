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
function bench(describeCall: unknown = vi.fn()) {
  const ctx = new Context()
  ctx.provide('connection', {
    api: { settings: { describe: describeCall } },
    authentication: {
      getSnapshot: () => ({ kind: 'bypass' as const }),
      subscribe: () => () => {},
      validate: () => true,
    },
  } as never)
  new TestRemote(ctx)
  return { ctx, fiber: ctx.plugin({ inject: [...inject], apply }) }
}

/** A healthy `settings.describe` answer the shared mirror can fold. */
function described() {
  return {
    rpcId: 'plugin-describe' as never,
    result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } },
    authentication: { kind: 'bypass' },
  }
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

  it('serves the one shared description through the scope service', async () => {
    const describeCall = vi.fn().mockResolvedValue(described())
    const { ctx, fiber } = bench(describeCall)
    await fiber.await()
    const binder = ctx.get('settingsScope') as SettingsScopeBinder

    const face = binder.describe()

    expect(face).toBe(binder.describe())
    await vi.waitFor(() => { expect(face.getSnapshot().status).toBe('ready') })
    expect(face.getSnapshot().view).toMatchObject({ writable: true, hasDocument: true })
  })

  it('reloads the shared description when the host forwards a settings document update', async () => {
    const describeCall = vi.fn().mockResolvedValue(described())
    const { ctx, fiber } = bench(describeCall)
    await fiber.await()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledOnce() })

    ctx.remote.$dispatch('settings/document-updated', [])

    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(2) })
    expect((ctx.get('settingsScope') as SettingsScopeBinder).describe().getSnapshot().status).toBe('ready')
  })
})
