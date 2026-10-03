# speech/ — voice input capability family

English | [中文](README.zh.md)

This family turns microphone recordings into composer text: one recognizer seam, two shipped recognizers (host-local SenseVoice and an OpenAI-compatible cloud chain), one settings namespace, and one browser surface (the composer microphone and its Settings section).

| Package | Role | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | Defines the recognizer registry, preferences, and WAV intake validation | `ctx.speech` |
| [`speech-sensevoice/`](speech-sensevoice/README.md) | Local SenseVoice provider: pinned sha256-verified assets, ordered source fallback, lazy native binding | registers on `ctx.speech` |
| [`speech-openai/`](speech-openai/README.md) | OpenAI-compatible cloud provider over an ordered endpoint chain | registers on `ctx.speech` |
| [`speech-settings/`](speech-settings/README.md) | Persists the `speech` settings namespace and bridges it into the registry | registers on `ctx.settings` |

The browser half lives in [`client/ui-voice-input`](../client/ui-voice-input/README.md); the Remote surface (`speech.transcribe`, `speech.prepare`, capability `harniverse.operate`) lives in the API gateway. The absorption decision and its verification are recorded in the [voice-input Agent Note](../../.agents/notes/implemented/feature/2026-10-03-voice-input.md).
