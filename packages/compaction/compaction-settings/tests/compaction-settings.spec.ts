import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import {
  SettingsProvider,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import * as compactionSettings from '@deepseek-ai/dsh-compaction-settings'

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

async function boot(config: compactionSettings.CompactionSettings = {}): Promise<{
  ctx: Context
  settingsFiber: Fiber
  pluginFiber: Fiber
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(compactionSettings, config)
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

describe('@deepseek-ai/dsh-compaction-settings', () => {
  it('registers an empty live namespace until a user stores an override', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.get(compactionSettings.COMPACTION_SETTINGS_NAMESPACE)).toEqual({})
    expect(bench.ctx.settings.describe()).toContainEqual(expect.objectContaining({
      ns: compactionSettings.COMPACTION_SETTINGS_NAMESPACE,
      applies: 'live',
    }))

    await bench.ctx.settings.replace(compactionSettings.COMPACTION_SETTINGS_NAMESPACE, { thresholdRatio: 0.65 })
    expect(bench.ctx.settings.get(compactionSettings.COMPACTION_SETTINGS_NAMESPACE)).toEqual({ thresholdRatio: 0.65 })
    await bench.ctx.fiber.dispose()
  })

  it('validates the supported threshold range and preserves a composition base', async () => {
    const bench = await boot({ thresholdRatio: 0.75 })
    expect(bench.ctx.settings.get(compactionSettings.COMPACTION_SETTINGS_NAMESPACE)).toEqual({ thresholdRatio: 0.75 })
    await expect(bench.ctx.settings.replace(compactionSettings.COMPACTION_SETTINGS_NAMESPACE, { thresholdRatio: 0.16 }))
      .rejects.toThrow()
    await expect(bench.ctx.settings.replace(compactionSettings.COMPACTION_SETTINGS_NAMESPACE, { thresholdRatio: 1.01 }))
      .rejects.toThrow()
    expect(bench.ctx.settings.get(compactionSettings.COMPACTION_SETTINGS_NAMESPACE)).toEqual({ thresholdRatio: 0.75 })
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the root plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('compaction')
    await bench.pluginFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('compaction')
    await bench.settingsFiber.dispose()
    await bench.ctx.fiber.dispose()
  })
})
