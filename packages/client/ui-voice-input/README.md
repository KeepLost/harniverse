# @deepseek-ai/dsh-client-ui-voice-input

English | [中文](README.zh.md)

Voice input, a pure browser surface plugin in two seats: the composer microphone control (`conversation.input.left`) and the Settings → Voice input section (`settings.section`). Recognition itself — the speech seam, providers, assets, and the `speech.transcribe` / `speech.prepare` Remote methods — is owned by the `@deepseek-ai/dsh-speech*` host packages composed independently on the host roster.

## Microphone control

A small always-visible button beside the composer chrome. Click starts a recording (`getUserMedia` + `MediaRecorder`); a second click stops, decodes through `AudioContext`, downmixes and resamples to canonical 16 kHz mono PCM16 WAV entirely in the browser, and sends `speech.transcribe`; the transcript inserts at the draft's end through the scoped `slash/input-insert-text` event (the draft-revision CAS guards it, and a miss offers the transcript for manual insertion). Holding the configured `pushToTalkKey` (settings namespace, lowercased) records while held — keydown starts, keyup stops and transcribes.

Readiness guidance is locale-owned (`voice` dictionary, zh/en): a disabled recognizer (`'off'`), refused microphone permission, unsupported capture APIs, an empty transcript, and wire failures each render their own copy instead of failing silently.

While recording, a live level meter (one bar per 100 ms over the capture's peak input level) shows the microphone is actually picking sound up; an empty transcript over a near-silent capture renders dedicated silence guidance with the measured duration and peak, separating "no sound reached the browser" from "the recognizer found no speech".

## Settings section

Recognizer selection (`off` / SenseVoice local / OpenAI-compatible cloud), language hint, push-to-talk key, local model precision (INT8/FP32), and the write-only cloud API key (the settings mirror redacts it; presence in the user layer marks it configured). The prepare button triggers `speech.prepare` and renders the settled status — ready, unprepared, or failed with the provider's detail — over the same section.

## Model Experience

### Voice transcripts as draft text

#### What the model sees

A transcript of `speech.transcribe` becomes ordinary composer draft text the user reviews and sends; nothing here adds prompt content or session events of its own.

#### Token effect

None; the package produces no tokens of its own beyond the draft text the user chooses to send.

#### KV Cache effect

None; no request-prefix changes.

## Known Limitations and Deferred Work

- **Whole-clip capture** — no streaming transcription; the recorder stops before the first byte leaves.
- **Insertion is end-of-draft only** — the transcript appends; insertion at the caret rides the upstream span CAS work and is deferred.
