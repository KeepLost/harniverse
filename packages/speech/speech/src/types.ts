/**
 * Provider-neutral speech transcription types shared by the Service
 * Definition (`ctx.speech`), recognizer providers, the settings bridge, and
 * the Remote consumer. The registry service lives in `./index.ts`.
 * @module @deepseek-ai/dsh-speech/types
 */

/** One complete recording admitted for transcription, in canonical PCM16 WAV form. */
export interface SpeechTranscribeInput {
  /** WAV bytes; borrowed until settlement. */
  readonly wav: Uint8Array
  /** BCP-47-ish language hint a provider may narrow (`'zh'`, `'en'`, …); omitted means auto-detect. */
  readonly language?: string
}

/** Final transcription of one recording; an empty string means no speech was recognized. */
export interface SpeechTranscribeResult {
  /** Recognized text without a trailing newline. */
  readonly text: string
}

/**
 * Resource readiness of one recognizer. `preparing` is caller-side pending
 * state; providers answer with a settled observation.
 */
export interface SpeechPreparation {
  /** Whether the recognizer can serve a transcription right now. */
  readonly status: 'ready' | 'unprepared' | 'failed'
  /** Provider-supplied diagnostic for a `failed` observation. */
  readonly detail?: string
}

/**
 * One replaceable recognizer. Implementations own preparation, execution,
 * and cancellation; the binding loads native code lazily at first use.
 */
export interface SpeechRecognizer {
  /** Registration id; consumers select this exact id (`'sensevoice'`, `'openai-compatible'`, …). */
  readonly id: string
  /** One-line human label for settings surfaces. */
  readonly label: string
  /** Where inference runs; guides setup guidance. */
  readonly location: 'host-local' | 'cloud'
  /**
   * Verify local resources without downloading. Absent means the recognizer
   * needs no preparation and reports ready implicitly.
   * @returns the settled readiness observation.
   */
  inspect?(): Promise<SpeechPreparation>
  /**
   * Download and verify every missing local resource, then report readiness.
   * @param signal - preparation cancellation.
   * @returns the settled readiness observation.
   */
  prepare?(signal?: AbortSignal): Promise<SpeechPreparation>
  /**
   * Recognize one complete recording.
   * @param input - WAV bytes and optional language hint.
   * @param signal - caller cancellation; rejection follows resource cleanup.
   * @returns final text; empty when no speech was recognized.
   */
  transcribe(input: SpeechTranscribeInput, signal?: AbortSignal): Promise<SpeechTranscribeResult>
}

/**
 * User preferences persisted through the `speech` settings namespace. New
 * recognizer ids extend the shipped closed set by editing the settings schema
 * beside their provider.
 */
export interface SpeechPreferences {
  /** Selected recognizer id, or the `'off'` sentinel while voice input is disabled. */
  readonly recognizer: string
  /** Default language hint passed when a request carries none. */
  readonly language?: string
  /** Keyboard key held for push-to-talk (e.g. `'shift'`); unset disables the gesture. */
  readonly pushToTalkKey?: string
  /** Local model weight precision; INT8 minimizes download and storage. */
  readonly modelVariant?: 'int8' | 'fp32'
  /** API key for the cloud recognizer; never crosses a redacted wire surface. */
  readonly apiKey?: string
}
