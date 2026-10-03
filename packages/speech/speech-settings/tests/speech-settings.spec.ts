import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpeechService from '@deepseek-ai/dsh-speech'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as speechSettings from '../src/index.ts'

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

async function boot(config: speechSettings.SpeechSettings = {}): Promise<Context> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(SpeechService)
  const fiber = ctx.plugin(speechSettings, config)
  await fiber
  return ctx
}

describe('@deepseek-ai/dsh-speech-settings', () => {
  it('registers a live namespace with off/int8 defaults and pushes them into ctx.speech', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(speechSettings.SPEECH_SETTINGS_NAMESPACE)).toEqual({ recognizer: 'off', modelVariant: 'int8' })
    expect(ctx.settings.describe()).toContainEqual(expect.objectContaining({
      ns: speechSettings.SPEECH_SETTINGS_NAMESPACE,
      applies: 'live',
    }))
    expect(ctx.speech.currentPreferences()).toEqual({ recognizer: 'off', modelVariant: 'int8' })
    await ctx.fiber.dispose()
  })

  it('follows every committed change into the registry', async () => {
    const ctx = await boot()
    await ctx.settings.update(speechSettings.SPEECH_SETTINGS_NAMESPACE, {
      recognizer: 'openai-compatible',
      language: 'zh',
      apiKey: 'sk-live',
      pushToTalkKey: 'shift',
    })
    expect(ctx.speech.currentPreferences()).toEqual({
      recognizer: 'openai-compatible',
      language: 'zh',
      pushToTalkKey: 'shift',
      modelVariant: 'int8',
      apiKey: 'sk-live',
    })
    await ctx.settings.replace(speechSettings.SPEECH_SETTINGS_NAMESPACE, { recognizer: 'sensevoice', modelVariant: 'fp32' })
    expect(ctx.speech.currentPreferences()).toEqual({ recognizer: 'sensevoice', modelVariant: 'fp32' })
    await ctx.fiber.dispose()
  })

  it('keeps a composition base and rejects values outside the schema', async () => {
    const ctx = await boot({ language: 'ja' })
    expect(ctx.speech.currentPreferences()).toEqual({ recognizer: 'off', language: 'ja', modelVariant: 'int8' })
    await expect(ctx.settings.update(speechSettings.SPEECH_SETTINGS_NAMESPACE, { recognizer: 'whisper' })).rejects.toThrow()
    await expect(ctx.settings.update(speechSettings.SPEECH_SETTINGS_NAMESPACE, { modelVariant: 'int4' })).rejects.toThrow()
    expect(ctx.speech.currentPreferences()).toEqual({ recognizer: 'off', language: 'ja', modelVariant: 'int8' })
    await ctx.fiber.dispose()
  })

  it('redacts the API key on described wire surfaces', async () => {
    const ctx = await boot()
    await ctx.settings.update(speechSettings.SPEECH_SETTINGS_NAMESPACE, { recognizer: 'openai-compatible', apiKey: 'sk-secret' })
    expect(ctx.speech.currentPreferences().apiKey).toBe('sk-secret')
    const described = ctx.settings.describe({ redactSecrets: true })
      .find(entry => entry.ns === speechSettings.SPEECH_SETTINGS_NAMESPACE)
    expect(JSON.stringify(described?.value)).not.toContain('sk-secret')
    await ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    await ctx.plugin(SpeechService)
    const fiber = ctx.plugin(speechSettings)
    await fiber
    await fiber.dispose()
    expect(ctx.settings.describe()).not.toContainEqual(expect.objectContaining({
      ns: speechSettings.SPEECH_SETTINGS_NAMESPACE,
    }))
    await ctx.fiber.dispose()
  })
})
