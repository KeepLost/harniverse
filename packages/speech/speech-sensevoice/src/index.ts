/**
 * Local SenseVoice provider plugin. Registers the `'sensevoice'` recognizer
 * into `ctx.speech`; assets live under `$DSH_HOME/speech/sensevoice/` and the
 * `sherpa-onnx-node` native binding (with its bundled ONNX Runtime) loads
 * lazily at the first transcription.
 * @module @deepseek-ai/dsh-speech-sensevoice
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SenseVoiceRecognizer, type SenseVoiceConfig } from './recognizer.ts'
import { SENSEVOICE_ASSET_ORIGINS } from './assets.ts'

export type { SenseVoiceConfig } from './recognizer.ts'
export { SenseVoiceRecognizer } from './recognizer.ts'
export { orderSources } from './sources.ts'
export { downloadAsset, SpeechAssetError, verifyAsset } from './download.ts'
export { createTranscriber, loadSherpaBinding, senseVoiceLanguage } from './inference.ts'
export { SENSEVOICE_ASSET_ORIGINS } from './assets.ts'

/** Cordis plugin name. */
export const name = 'speech-sensevoice'
/** The recognizer registry this provider registers into. */
export const inject = ['speech']

/** Validate deployment-varying local-runtime choices at plugin activation. */
export const Config: z<Partial<SenseVoiceConfig>, SenseVoiceConfig> = z.object({
  dataRoot: z.string().min(1).required(),
  origins: z.array(z.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/)).min(1)
    .default([...SENSEVOICE_ASSET_ORIGINS]),
  probeTimeoutMs: z.natural().min(1).default(3_000),
  threads: z.natural().min(1).default(2),
  segmentSeconds: z.number().min(1).max(120).default(30),
  vadThreshold: z.number().min(0).max(1).default(0.5),
  minSpeechSeconds: z.number().min(0).default(0.25),
  minSilenceSeconds: z.number().min(0.01).default(0.5),
  maxDurationSeconds: z.number().min(1).default(120),
})

/**
 * Register the local recognizer.
 * @param ctx - host context carrying `ctx.speech`.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: SenseVoiceConfig): void {
  ctx.speech.registerRecognizer('sensevoice', new SenseVoiceRecognizer(config, {
    preferences: () => ctx.speech.currentPreferences(),
  }))
}
