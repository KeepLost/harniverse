/** Registration behavior of the exec-world settings plugin. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as execWorldSettings from '../src/index.ts'

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
  const fiber = ctx.plugin(execWorldSettings)
  await fiber
  return ctx
}

describe('@deepseek-ai/dsh-exec-world-settings', () => {
  it('registers a restart namespace defaulting to the local world', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE))
      .toEqual({ world: 'local' })
    expect(ctx.settings.describe()).toContainEqual(expect.objectContaining({
      ns: execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE,
      applies: 'restart',
    }))
    await ctx.fiber.dispose()
  })

  it('seeds the stored vm preference through the user layer', async () => {
    const ctx = await boot({ 'exec-world': { world: 'vm' } })
    expect(ctx.settings.get(execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE))
      .toEqual({ world: 'vm' })
    await ctx.fiber.dispose()
  })

  it('follows a committed preference into the resolved namespace value', async () => {
    const ctx = await boot()
    await ctx.settings.update(execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE, { world: 'vm' })
    expect(ctx.settings.get(execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE)).toEqual({ world: 'vm' })
    await ctx.fiber.dispose()
  })

  it('rejects a world the schema cannot express', async () => {
    const ctx = await boot()
    await expect(ctx.settings.update(execWorldSettings.EXEC_WORLD_SETTINGS_NAMESPACE, {
      world: 'cloud',
    })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
