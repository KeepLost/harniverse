# @deepseek-ai/dsh-speech-openai

English | [中文](README.zh.md)

OpenAI-compatible cloud recognizer provider for `ctx.speech`, registered as `'openai-compatible'`. One multipart `/audio/transcriptions` POST per recording, through an ordered endpoint chain.

## Endpoint chain

`endpoints` (default `['https://api.openai.com/v1']`; deployment overlays append compatible gateways in priority order) is walked per request: transport failures (DNS, TLS, refused), timeouts, and retriable statuses (408, 429, 5xx) fall through to the next endpoint, while a definitive 4xx answer — bad key, bad request — fails the whole chain immediately, because every gateway shares the key and would repeat the semantics. `model` (default `whisper-1`), `timeoutMs` (default 120 s) per endpoint.

The API key and default language come from the `speech` settings namespace (`apiKey` is a `role('secret')` field, so it never rides a redacted wire surface). A missing key fails with setup guidance before any bytes leave; `inspect` answers `unprepared` while the key is unset, so the Settings section can guide.

## Model Experience

### Cloud transcription results

#### What the model sees

The `/audio/transcriptions` reply text becomes user-visible output only; nothing enters a model request directly.

#### Token effect

None; the recognizer contributes no tokens — only its returned text can reach a draft.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No streaming transcription** — one request per complete recording; the composer records whole clips.
- **One key for the whole chain** — per-gateway credentials would need a credential-ref field like the llm adapters; deferred until a real multi-gateway deployment asks.
- **No response caching** — identical recordings re-bill; the composer never replays a recording on its own.
