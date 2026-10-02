# Speech Recognition

English | [中文](speech.zh.md)

The speech seam turns a recorded utterance into text for the composer. A recognizer provider registers itself on `ctx.speech`; the service validates WAV input, resolves the configured provider from the `speech` settings namespace, and returns the transcription. Nothing here touches the microphone: clients capture audio and the seam stays transport-free.

Source: [`packages/speech/speech/src/index.ts`](../../packages/speech/speech/src/index.ts)

## Service surface

```ts type-equiv
/**
 * One replaceable recognizer. Implementations own preparation, execution,
 * and cancellation; the binding loads native code lazily at first use.
 */
interface SpeechRecognizer {
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
```

The service exposes registration (`registerRecognizer`), resolution (`resolve`, `listRecognizers`), preference bridging (`configure`, `currentPreferences`), asset preparation (`prepare`), and transcription (`transcribe`). WAV input is validated by the seam — RIFF header, PCM16 format, parameterized duration ceiling — before any provider sees it.

## Providers

- **`speech-sensevoice`** — local recognizer. Pinned sha256 model assets under `<DSH_HOME>/speech/sensevoice/`, ordered source probing with atomic download, `int8`/`fp32` variants, and a native binding loaded lazily on first transcription. `prepare` downloads and verifies the assets; `transcribe` runs offline inference.
- **`speech-openai`** — cloud recognizer against OpenAI-compatible `/audio/transcriptions` endpoints with an ordered chain and deterministic-4xx fast failure.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechservice"></a>

### `ctx.speech` — `SpeechService`

Process-wide recognizer registry and preference holder. Load it as a plugin and it registers as `ctx.speech`; providers then register recognizers into it and `@deepseek-ai/dsh-speech-settings` pushes the user's resolved preferences. Registrations are effects: a provider's fiber disposal removes its recognizer.

```ts cordis-catalog
/**
 * Register one recognizer under its own id.
 * @param id - registry id; a duplicate registration fails loud.
 * @param recognizer - the provider implementation.
 * @returns disposer that removes the registration.
 */
registerRecognizer(id: string, recognizer: SpeechRecognizer): () => void

/**
 * List every registered recognizer.
 * @returns every registered recognizer in registration order.
 */
listRecognizers(): readonly SpeechRecognizer[]

/**
 * Look up one registered recognizer.
 * @param id - registry id.
 * @returns the recognizer, or undefined when absent.
 */
recognizer(id: string): SpeechRecognizer | undefined

/**
 * Replace the resolved preferences. The settings bridge owns this write;
 * callers read through {@link SpeechService.currentPreferences}.
 * @param preferences - the complete next resolved value.
 */
configure(preferences: SpeechPreferences): void

/**
 * Read the current resolved preferences.
 * @returns the current resolved preferences (defaults while no bridge is loaded).
 */
currentPreferences(): SpeechPreferences

/**
 * Resolve the recognizer a transcription should use.
 * @param recognizerId - explicit id overriding the preference; omitted uses it.
 * @returns the paired recognizer and language hint, or the refusal reason.
 */
resolve(recognizerId?: string): SpeechResolution

/**
 * Prepare one recognizer's local resources (download and verify).
 * @param recognizerId - explicit id overriding the preference; omitted uses it.
 * @param signal - preparation cancellation.
 * @returns the settled readiness observation, or the refusal reason.
 */
async prepare(recognizerId?: string, signal?: AbortSignal): Promise<SpeechPreparation | SpeechRefusal>

/**
 * Transcribe one recording through the resolved recognizer.
 * @param input - WAV bytes and optional language hint overriding the preference.
 * @param signal - caller cancellation.
 * @returns final text; empty when no speech was recognized.
 */
async transcribe(input: SpeechTranscribeInput, signal?: AbortSignal): Promise<SpeechTranscribeResult>
```

Source: [`packages/speech/speech/src/index.ts:53`](../../packages/speech/speech/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Model experience

Speech input is user-initiated: the microphone control and push-to-talk key transcribe a recording into the composer draft. The model never sees audio, only the transcribed text, so no prompt or token behavior changes.

## Known Limitations

- The local recognizer loads its native binding in-process; a worker-process isolation upgrade is deferred.
- Cloud transcription requires a configured API key and fails fast when absent.
