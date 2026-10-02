# @deepseek-ai/dsh-speech

English | [中文](README.zh.md)

The speech transcription Service Definition (`ctx.speech`): the recognizer registry, the user's resolved preferences, and canonical WAV intake validation. Load it as a plugin and it registers as `ctx.speech`; recognizer providers register into it and the settings bridge pushes preferences.

## Contract

- `SpeechRecognizer` — one replaceable recognizer: optional `inspect` (settled readiness without downloading), optional `prepare` (download and sha256-verify local resources), and `transcribe({ wav, language? }, signal?) → { text }`.
- `SpeechService.registerRecognizer(id, recognizer)` — effect-scoped registration; duplicate ids and id mismatches fail loud, and the registering fiber's disposal removes the recognizer.
- `configure(preferences)` / `currentPreferences()` — the preference bridge owned by [`@deepseek-ai/dsh-speech-settings`](../speech-settings/README.md); `resolve()` answers the paired recognizer and language hint or a refusal (`disabled` / `unknown`).
- `prepare(id?)` — joins the resolved recognizer's preparation task, answering the settled observation or the refusal.
- `transcribe(input, signal?)` — resolves through the preferences, merges the request language over the preference default, and delegates.
- `validateWav(bytes, { sampleRate?, channels?, maxDurationSeconds })` — canonical PCM16 RIFF validation (44-byte header, one `fmt ` chunk, consistent sizes), parameterized; defaults match the provider-canonical 16 kHz mono.

Shipped recognizers: [`@deepseek-ai/dsh-speech-sensevoice`](../speech-sensevoice/README.md) (`'sensevoice'`, host-local) and [`@deepseek-ai/dsh-speech-openai`](../speech-openai/README.md) (`'openai-compatible'`, cloud).

## Model Experience

### Seam-owned transcription contract

#### What the model sees

`ctx.speech.transcribe` returns plain text from the resolved recognizer; the caller decides where it lands, and the seam adds no prompt content of its own.

#### Token effect

None; the seam contributes no tokens — only returned text can reach a caller's draft.

#### KV Cache effect

None; the seam neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One preference source** — the registry holds no persistence; a composition without `dsh-speech-settings` serves the `'off'` defaults until the bridge loads.
- **Recognizers are process-singletons per id** — one registration per id per context, matching cordis' duplicate-service behavior.
