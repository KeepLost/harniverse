/** Registration behavior of the shell-backend settings plugin. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as shellBackendSettings from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(section?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  if (section !== undefined) {
    class SeededMemorySettings extends MemorySettings {
      override doc: Record<string, unknown> = structuredClone(section ?? {})
    }
    const settingsFiber = ctx.plugin(SeededMemorySettings)
    await settingsFiber.await()
  } else {
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
  }
  const fiber = ctx.plugin(shellBackendSettings)
  await fiber
  return ctx
}

describe('@deepseek-ai/dsh-shell-backend-settings', () => {
  it('registers a restart namespace defaulting to the platform backend', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE))
      .toEqual({ backend: 'platform-default' })
    expect(ctx.settings.describe()).toContainEqual(expect.objectContaining({
      ns: shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE,
      applies: 'restart',
    }))
    await ctx.fiber.dispose()
  })

  it('follows a committed preference into the resolved namespace value', async () => {
    const ctx = await boot()
    await ctx.settings.update(shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE, { backend: 'git-bash' })
    expect(ctx.settings.get(shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE)).toEqual({ backend: 'git-bash' })
    await ctx.fiber.dispose()
  })

  it('resolves a stored user section as the base layer', async () => {
    const ctx = await boot({ 'shell-backend': { backend: 'git-bash' } })
    expect(ctx.settings.get(shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE)).toEqual({ backend: 'git-bash' })
    await ctx.fiber.dispose()
  })

  it('rejects a backend the schema cannot express', async () => {
    const ctx = await boot()
    await expect(ctx.settings.update(shellBackendSettings.SHELL_BACKEND_SETTINGS_NAMESPACE, {
      backend: 'cmd',
    })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
