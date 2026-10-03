/**
 * Root-owned settings contract for voice input: the `speech` namespace
 * (`$DSH_HOME/settings.yaml`, hot-reloaded) persisting recognizer choice,
 * language hint, push-to-talk key, local model variant, and the cloud API
 * key. Registering also pushes the resolved value into `ctx.speech`, and
 * every committed change follows it, so consumers and providers read one
 * live preference source.
 * @module @deepseek-ai/dsh-speech-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SpeechPreferences } from '@deepseek-ai/dsh-speech'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace read at transcription, preparation, and composer mounts. */
export const SPEECH_SETTINGS_NAMESPACE = settingsNamespace('speech')

/** Stored voice-input settings; every field is optional over the schema defaults. */
export interface SpeechSettings {
  /** Selected recognizer, or `'off'` while voice input is disabled. */
  recognizer?: 'off' | 'sensevoice' | 'openai-compatible'
  /** Default language hint (`'zh'`, `'en'`, …) passed when a request carries none. */
  language?: string
  /** Keyboard key held for push-to-talk (`'shift'`, `'ctrl'`, a letter); unset disables the gesture. */
  pushToTalkKey?: string
  /** Local SenseVoice weight precision; INT8 minimizes download and storage. */
  modelVariant?: 'int8' | 'fp32'
  /** Cloud recognizer API key; declared secret so it never rides a redacted wire surface. */
  apiKey?: string
}

/** Stored voice-input settings schema. */
export const Config: z<SpeechSettings> = z.object({
  recognizer: z.union([z.const('off'), z.const('sensevoice'), z.const('openai-compatible')]),
  language: z.string().min(2).max(35),
  pushToTalkKey: z.string().min(1).max(32),
  modelVariant: z.union([z.const('int8'), z.const('fp32')]),
  apiKey: z.string().min(1).role('secret'),
})

/** Resolved defaults applied under the user layer. */
const BASE: SpeechSettings = { recognizer: 'off', modelVariant: 'int8' }

/** Cordis plugin name. */
export const name = 'speech-settings'
/** The settings provider owns persistence; the registry receives the resolved value. */
export const inject = ['settings', 'speech']

/** Narrow a resolved settings value to the shared preferences contract. */
function preferencesOf(resolved: SpeechSettings): SpeechPreferences {
  return {
    /* v8 ignore next 1 -- the registered base always carries recognizer; the default keeps the helper total over partial values. */
    recognizer: resolved.recognizer ?? 'off',
    ...resolved.language === undefined ? {} : { language: resolved.language },
    ...resolved.pushToTalkKey === undefined ? {} : { pushToTalkKey: resolved.pushToTalkKey },
    /* v8 ignore next 1 -- the registered base always carries modelVariant; the empty arm keeps the helper total over partial values. */
    ...resolved.modelVariant === undefined ? {} : { modelVariant: resolved.modelVariant },
    ...resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey },
  }
}

/**
 * Register the process-wide voice-input settings namespace and keep
 * `ctx.speech` aligned with every committed change.
 * @param ctx - host context carrying the settings provider and the registry.
 * @param config - composition `base` layer over the schema defaults.
 */
export function apply(ctx: Context, config: SpeechSettings = {}): void {
  const scope = ctx.settings.register(SPEECH_SETTINGS_NAMESPACE, Config, {
    applies: 'live',
    base: { ...BASE, ...config },
  })
  const push = (): void => { ctx.speech.configure(preferencesOf(scope.get())) }
  push()
  ctx.effect(() => scope.watch(() => { push() }), 'speech-settings: preference bridge')
}
