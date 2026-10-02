/**
 * The local SenseVoice recognizer: pinned-asset preparation with sha256
 * verification, manifest guarding, ordered source fallback, and a lazily
 * loaded native binding. Instantiated by this package's plugin; suites
 * construct it directly with scripted fetch and binding loaders.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechPreparation, SpeechRecognizer, SpeechTranscribeInput, SpeechTranscribeResult } from '@deepseek-ai/dsh-speech'
import {
  ASSET_MANIFEST_VERSION, pinnedManifest,
  type AssetManifest, type PinnedAsset, type SenseVoiceVariant,
} from './assets.ts'
import { downloadAsset, SpeechAssetError, verifyAsset } from './download.ts'
import { createTranscriber, loadSherpaBinding, senseVoiceLanguage, type SherpaBinding } from './inference.ts'
import { orderSources, type FetchLike } from './sources.ts'

/** Deployment configuration consumed by the recognizer. */
export interface SenseVoiceConfig {
  /** Root under which the `sensevoice/` asset directory is created (`$DSH_HOME/speech`). */
  readonly dataRoot: string
  /** Hugging Face-compatible origins probed in order before each missing download. */
  readonly origins: string[]
  /** Deadline for concurrent HEAD probes. */
  readonly probeTimeoutMs: number
  /** CPU intra-operation thread count. */
  readonly threads: number
  /** Maximum speech segment length passed to the recognizer. */
  readonly segmentSeconds: number
  /** Silero speech probability threshold. */
  readonly vadThreshold: number
  /** Minimum speech duration retained by VAD. */
  readonly minSpeechSeconds: number
  /** Silence separating two speech segments. */
  readonly minSilenceSeconds: number
  /** Maximum admitted recording duration. */
  readonly maxDurationSeconds: number
}

/** Construction dependencies; `fetchImpl`, `loadBinding`, and `assets` are suite injection points. */
export interface SenseVoiceDeps {
  /** Resolved user preferences; supplies the `modelVariant` selection. */
  readonly preferences: () => { readonly modelVariant?: 'int8' | 'fp32' }
  /** Fetch implementation for downloads and probes; defaults to the global fetch. */
  readonly fetchImpl?: FetchLike
  /** Native binding loader; defaults to the lazy `sherpa-onnx-node` require. */
  readonly loadBinding?: () => SherpaBinding
  /** Pinned asset manifest; defaults to the release pins in `./assets.ts`. */
  readonly assets?: () => AssetManifest
}

/** Verified local file paths for one precision variant. */
interface AssetFiles {
  readonly model: PinnedAsset
  readonly tokens: PinnedAsset
  readonly vad: PinnedAsset
  readonly paths: { readonly model: string; readonly tokens: string; readonly vad: string }
}

function sameAsset(a: PinnedAsset, b: PinnedAsset): boolean {
  return a.name === b.name && a.url === b.url && a.bytes === b.bytes && a.sha256 === b.sha256
}

/**
 * The host-local recognizer registered as `'sensevoice'`. One instance owns
 * one asset directory, one in-flight preparation task, and one lazily created
 * native transcriber.
 */
export class SenseVoiceRecognizer implements SpeechRecognizer {
  readonly id = 'sensevoice'
  readonly label = 'SenseVoice (local)'
  readonly location = 'host-local'

  private preparation: Promise<void> | undefined
  private transcriber: ((wav: Uint8Array, language: string | undefined) => { text: string; audioSeconds: number }) | undefined

  /**
   * @param config - deployment configuration.
   * @param deps - preferences access and suite injection points.
   */
  constructor(private readonly config: SenseVoiceConfig, private readonly deps: SenseVoiceDeps) {}

  private get directory(): string {
    return join(this.config.dataRoot, 'sensevoice')
  }

  private get manifestPath(): string {
    return join(this.directory, 'manifest.json')
  }

  /** @returns the precision variant selected by the user's resolved preferences. */
  private variant(): SenseVoiceVariant {
    return this.deps.preferences().modelVariant ?? 'int8'
  }

  private files(variant: SenseVoiceVariant): AssetFiles {
    const { assets } = this.pinned(variant)
    const { model, tokens, vad } = assets
    return {
      model,
      tokens,
      vad,
      paths: {
        model: join(this.directory, model.name),
        tokens: join(this.directory, tokens.name),
        vad: join(this.directory, vad.name),
      },
    }
  }

  private pinned(variant: SenseVoiceVariant): AssetManifest {
    return (this.deps.assets ?? pinnedManifest)(variant)
  }

  /**
   * Whether the on-disk manifest records exactly the pinned assets.
   * @param variant - selected precision variant.
   * @returns true when the manifest exists, matches the schema version, and
   * pins the same digests; false when absent or drifted.
   */
  private async manifestMatches(variant: SenseVoiceVariant): Promise<boolean> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.manifestPath, 'utf8'))
    } catch {
      return false
    }
    const manifest = parsed as AssetManifest
    const pinned = this.pinned(variant)
    return manifest.version === ASSET_MANIFEST_VERSION
      && sameAsset(manifest.assets.model, pinned.assets.model)
      && sameAsset(manifest.assets.tokens, pinned.assets.tokens)
      && sameAsset(manifest.assets.vad, pinned.assets.vad)
  }

  /** @returns the settled readiness observation without downloading anything. */
  async inspect(): Promise<SpeechPreparation> {
    const files = this.files(this.variant())
    try {
      const verified = await Promise.all([
        verifyAsset(files.paths.model, files.model),
        verifyAsset(files.paths.tokens, files.tokens),
        verifyAsset(files.paths.vad, files.vad),
      ])
      if (verified.every(ok => ok)) {
        if (!await this.manifestMatches(this.variant())) {
          return { status: 'failed', detail: 'the asset manifest does not match the pinned release; run preparation to repair it' }
        }
        return { status: 'ready' }
      }
      return { status: 'unprepared' }
    } catch (error) {
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Download and verify every missing or drifted asset, then write the
   * manifest. Repeated calls join the in-flight task.
   * @param signal - preparation cancellation.
   */
  private async runPreparation(signal: AbortSignal | undefined): Promise<void> {
    const variant = this.variant()
    const files = this.files(variant)
    const download = async (asset: PinnedAsset): Promise<void> => {
      if (await verifyAsset(join(this.directory, asset.name), asset, signal)) return
      const urls = await orderSources(asset.url, this.config.origins, this.config.probeTimeoutMs, signal, this.deps.fetchImpl)
      for (const [index, url] of urls.entries()) {
        try {
          await downloadAsset({ ...asset, url }, this.directory, {
            ...(signal === undefined ? {} : { signal }),
            ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
          })
          return
        } catch (error) {
          const fallback = error instanceof SpeechAssetError
            && (error.reason === 'http' || error.reason === 'network')
            && index < urls.length - 1
          if (!fallback) throw error
        }
      }
    }
    await download(files.model)
    await download(files.tokens)
    await download(files.vad)
    await writeFile(this.manifestPath, `${JSON.stringify(this.pinned(variant), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  /**
   * Start or join preparation and report the settled observation.
   * @param signal - preparation cancellation.
   * @returns readiness after the task settles.
   */
  async prepare(signal?: AbortSignal): Promise<SpeechPreparation> {
    if (this.preparation === undefined) {
      this.preparation = this.runPreparation(signal).finally(() => { this.preparation = undefined })
    }
    try {
      await this.preparation
    } catch (error) {
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
    return await this.inspect()
  }

  /**
   * Transcribe one canonical 16 kHz mono PCM16 WAV recording, preparing
   * assets on demand and loading the native binding on first use.
   * @param input - WAV bytes and optional language hint.
   * @param signal - caller cancellation (honored during asset preparation).
   * @returns recognized text; empty when no speech was found.
   */
  async transcribe(input: SpeechTranscribeInput, signal?: AbortSignal): Promise<SpeechTranscribeResult> {
    senseVoiceLanguage(input.language)
    const readiness = await this.prepare(signal)
    if (readiness.status !== 'ready') {
      throw new Error(`SenseVoice is not ready: ${readiness.status}${readiness.detail === undefined ? '' : ` (${readiness.detail})`}`)
    }
    this.transcriber ??= createTranscriber(this.files(this.variant()).paths, {
      threads: this.config.threads,
      segmentSeconds: this.config.segmentSeconds,
      vadThreshold: this.config.vadThreshold,
      minSpeechSeconds: this.config.minSpeechSeconds,
      minSilenceSeconds: this.config.minSilenceSeconds,
      maxDurationSeconds: this.config.maxDurationSeconds,
    }, (this.deps.loadBinding ?? loadSherpaBinding)())
    return { text: this.transcriber(input.wav, input.language).text }
  }
}
