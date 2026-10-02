/**
 * The speech transcription Service Definition (`ctx.speech`). It owns the
 * recognizer registry, the user's persisted preferences, and request
 * resolution; local and cloud execution live in provider plugins
 * (`@deepseek-ai/dsh-speech-sensevoice`, `@deepseek-ai/dsh-speech-openai`)
 * and persistence lives in `@deepseek-ai/dsh-speech-settings`.
 * @module @deepseek-ai/dsh-speech
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  SpeechPreparation, SpeechPreferences, SpeechRecognizer, SpeechTranscribeInput, SpeechTranscribeResult,
} from './types.ts'

export type {
  SpeechPreparation,
  SpeechPreferences,
  SpeechRecognizer,
  SpeechTranscribeInput,
  SpeechTranscribeResult,
} from './types.ts'
export { validateWav } from './wave.ts'
export type { WaveExpectations } from './wave.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    speech: SpeechService
  }
}

/** Refusal outcome: the requested id cannot serve a request. */
export interface SpeechRefusal {
  readonly ok: false
  readonly reason: 'disabled' | 'unknown'
  readonly recognizer: string
}

/** Recognizer selection outcome. */
export type SpeechResolution =
  | { readonly ok: true; readonly recognizer: SpeechRecognizer; readonly language?: string }
  | SpeechRefusal

/** The disabled preferences used until the settings bridge pushes a resolved value. */
const DEFAULT_PREFERENCES: SpeechPreferences = { recognizer: 'off' }

/**
 * Process-wide recognizer registry and preference holder. Load it as a
 * plugin and it registers as `ctx.speech`; providers then register
 * recognizers into it and `@deepseek-ai/dsh-speech-settings` pushes the
 * user's resolved preferences. Registrations are effects: a provider's fiber
 * disposal removes its recognizer.
 */
export class SpeechService extends Service {
  private readonly recognizers = new Map<string, SpeechRecognizer>()
  private preferences: SpeechPreferences = DEFAULT_PREFERENCES

  constructor(ctx: Context) {
    super(ctx, 'speech')
  }

  /**
   * Register one recognizer under its own id.
   * @param id - registry id; a duplicate registration fails loud.
   * @param recognizer - the provider implementation.
   * @returns disposer that removes the registration.
   */
  registerRecognizer(id: string, recognizer: SpeechRecognizer): () => void {
    if (id !== recognizer.id) throw new Error(`speech recognizer registration id "${id}" does not match the recognizer's own id "${recognizer.id}"`)
    if (this.recognizers.has(id)) throw new Error(`speech recognizer "${id}" is already registered`)
    const dispose = this.ctx.effect(() => {
      this.recognizers.set(id, recognizer)
      return () => { this.recognizers.delete(id) }
    }, `speech.registerRecognizer(${JSON.stringify(id)})`)
    return () => { void dispose() }
  }

  /** @returns every registered recognizer in registration order. */
  listRecognizers(): readonly SpeechRecognizer[] {
    return [...this.recognizers.values()]
  }

  /**
   * Look up one registered recognizer.
   * @param id - registry id.
   * @returns the recognizer, or undefined when absent.
   */
  recognizer(id: string): SpeechRecognizer | undefined {
    return this.recognizers.get(id)
  }

  /**
   * Replace the resolved preferences. The settings bridge owns this write;
   * callers read through {@link SpeechService.currentPreferences}.
   * @param preferences - the complete next resolved value.
   */
  configure(preferences: SpeechPreferences): void {
    this.preferences = preferences
  }

  /** @returns the current resolved preferences (defaults while no bridge is loaded). */
  currentPreferences(): SpeechPreferences {
    return this.preferences
  }

  /**
   * Resolve the recognizer a transcription should use.
   * @param recognizerId - explicit id overriding the preference; omitted uses it.
   * @returns the paired recognizer and language hint, or the refusal reason.
   */
  resolve(recognizerId?: string): SpeechResolution {
    const id = recognizerId ?? this.preferences.recognizer
    const recognizer = this.recognizers.get(id)
    if (id === 'off' || recognizerId === 'off') return { ok: false, reason: 'disabled', recognizer: id }
    if (recognizer === undefined) return { ok: false, reason: 'unknown', recognizer: id }
    return {
      ok: true,
      recognizer,
      ...this.preferences.language === undefined ? {} : { language: this.preferences.language },
    }
  }

  /**
   * Prepare one recognizer's local resources (download and verify).
   * @param recognizerId - explicit id overriding the preference; omitted uses it.
   * @param signal - preparation cancellation.
   * @returns the settled readiness observation, or the refusal reason.
   */
  async prepare(recognizerId?: string, signal?: AbortSignal): Promise<SpeechPreparation | SpeechRefusal> {
    const resolved = this.resolve(recognizerId)
    if (!resolved.ok) return resolved
    if (resolved.recognizer.prepare === undefined) return { status: 'ready' }
    return await resolved.recognizer.prepare(signal)
  }

  /**
   * Transcribe one recording through the resolved recognizer.
   * @param input - WAV bytes and optional language hint overriding the preference.
   * @param signal - caller cancellation.
   * @returns final text; empty when no speech was recognized.
   */
  async transcribe(input: SpeechTranscribeInput, signal?: AbortSignal): Promise<SpeechTranscribeResult> {
    const resolved = this.resolve()
    if (!resolved.ok) {
      throw new Error(resolved.reason === 'disabled'
        ? 'speech recognition is disabled (recognizer is off)'
        : `speech recognizer "${resolved.recognizer}" is not registered`)
    }
    const language = input.language ?? resolved.language
    return await resolved.recognizer.transcribe(
      { wav: input.wav, ...language === undefined ? {} : { language } },
      signal,
    )
  }
}

export default SpeechService
