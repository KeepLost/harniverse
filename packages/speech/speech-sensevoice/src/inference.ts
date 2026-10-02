/**
 * CPU SenseVoice inference with Silero segmentation, through the
 * `sherpa-onnx-node` native binding loaded lazily on first use. The binding
 * and its bundled ONNX Runtime enter the process only when a transcription
 * actually runs; preparing assets never loads native code.
 */

import { createRequire } from 'node:module'
import { validateWav } from '@deepseek-ai/dsh-speech'

/** Verified local files the transcriber loads. */
export interface InferenceFiles {
  /** SenseVoice ONNX model of the selected precision. */
  readonly model: string
  /** SenseVoice token table. */
  readonly tokens: string
  /** Silero VAD ONNX model. */
  readonly vad: string
}

/** Inference tuning; fixed protocol values (16 kHz mono fbank) stay hardcoded. */
export interface InferenceOptions {
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

interface Stream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer {
  createStream(): Stream
  setConfig(config: object): void
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}
interface Detector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(externalBuffer: false): { samples: Float32Array }
  pop(): void
  reset(): void
  flush(): void
}
interface Sherpa {
  OfflineRecognizer: new (config: object) => Recognizer
  Vad: new (config: object, bufferSeconds: number) => Detector
}

/** Native binding face loaded lazily; structural because sherpa-onnx-node ships no declarations. */
export type SherpaBinding = Sherpa

/**
 * Load the native `sherpa-onnx-node` binding (CommonJS Node-API addon with
 * JSDoc but no type declarations). Called at most once per recognizer.
 * @returns the binding's OfflineRecognizer and Vad constructors.
 */
export function loadSherpaBinding(): SherpaBinding {
  return createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
}

/** Languages SenseVoice trained on; `auto` lets the model decide. */
const LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

/**
 * Narrow a request language hint to a SenseVoice language code.
 * @param language - BCP-47-ish hint; undefined means `auto`.
 * @returns the supported code.
 * @throws `Error` for a hint outside the trained set.
 */
export function senseVoiceLanguage(language: string | undefined): string {
  const code = (language ?? 'auto').toLowerCase().split('-')[0] ?? 'auto'
  if (!LANGUAGES.has(code)) throw new Error(`Unsupported SenseVoice language: ${String(language)}`)
  return code
}

/**
 * Create the synchronous transcriber over verified files and the loaded
 * binding. Every recording resets VAD and updates the language hint.
 * @param files - verified model, tokens, and VAD paths.
 * @param options - CPU/VAD limits.
 * @param binding - already-loaded native binding.
 * @returns the transcriber: WAV bytes plus a language hint in, text out.
 */
export function createTranscriber(files: InferenceFiles, options: InferenceOptions, binding: SherpaBinding) {
  const nativeConfig = {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: files.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: files.tokens,
      numThreads: options.threads,
      provider: 'cpu',
      debug: 0,
    },
  }
  const recognizer = new binding.OfflineRecognizer(nativeConfig)
  const detector = new binding.Vad({
    sileroVad: {
      model: files.vad,
      threshold: options.vadThreshold,
      minSilenceDuration: options.minSilenceSeconds,
      minSpeechDuration: options.minSpeechSeconds,
      maxSpeechDuration: options.segmentSeconds,
      windowSize: 512,
    },
    sampleRate: 16_000,
    numThreads: options.threads,
    provider: 'cpu',
    debug: 0,
  }, options.segmentSeconds + options.minSilenceSeconds + 1)
  return (wav: Uint8Array, language: string | undefined): { text: string; audioSeconds: number } => {
    const audioSeconds = validateWav(wav, { maxDurationSeconds: options.maxDurationSeconds })
    const pcm = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44)
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32_768)
    nativeConfig.modelConfig.senseVoice.language = senseVoiceLanguage(language)
    recognizer.setConfig(nativeConfig)
    detector.reset()
    const texts: string[] = []
    const drain = (): void => {
      while (!detector.isEmpty()) {
        // VAD output must be copied before the next native call reuses it.
        const segment = detector.front(false)
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16_000, samples: segment.samples })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush()
    drain()
    return { text: texts.filter(Boolean).join(' ').trim(), audioSeconds }
  }
}
