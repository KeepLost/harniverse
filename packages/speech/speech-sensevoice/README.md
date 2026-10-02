# @deepseek-ai/dsh-speech-sensevoice

English | [中文](README.zh.md)

Local SenseVoice recognizer provider for `ctx.speech`, registered as `'sensevoice'`. Assets are release-pinned and sha256-verified; the `sherpa-onnx-node` native binding (with its bundled ONNX Runtime) loads lazily at the first transcription.

## Assets and preparation

Assets live under `$DSH_HOME/speech/sensevoice/` (`dataRoot` + `sensevoice/`): the SenseVoice model of the selected precision (`modelVariant` preference, INT8 default), `tokens.txt`, and the Silero VAD. Each file is pinned by URL revision, exact byte size, and sha256 (`src/assets.ts`, copied from the upstream release); after verification the provider writes `manifest.json` recording the accepted pins, and `inspect` fails when the manifest drifts.

`prepare` downloads each missing or corrupted asset through the ordered source chain — HEAD probes race `https://huggingface.co` and `https://hf-mirror.com` (the first to answer leads; both remain fallbacks), and HTTP/network failures fall through to the next source while integrity failures abort. Downloads stream into a unique `.part` file, hash while streaming, and publish atomically; a wrong size or digest never lands. Repeated calls join the in-flight task, and an already-verified directory re-verifies without network.

`transcribe` prepares on demand, validates the recording as canonical 16 kHz mono PCM16 (`maxDurationSeconds`, default 120), loads the binding once, and segments speech through Silero VAD before recognition. Languages: `zh`, `en`, `ja`, `ko`, `yue`, and `auto` (the default); other hints fail loud.

## Configuration (cordis.yml)

`dataRoot` (required; the shipped composition pins `!!js dshHomePath('speech')`), `origins` (default the two origins above), `probeTimeoutMs` (3 s), `threads` (2), `segmentSeconds` (30), `vadThreshold` (0.5), `minSpeechSeconds` (0.25), `minSilenceSeconds` (0.5), `maxDurationSeconds` (120).

## Model Experience

Indirectly, through the `speech.transcribe` Remote method and the composer microphone control; transcripts are ordinary draft text.

#### KV Cache effect

None; recognition never enters a model request.

## Known Limitations and Deferred Work

- **In-process inference** — the native binding loads in the harness process at first transcription (upstream isolates it in a worker process); a native crash takes the process down. Promotion to the worker shape is deferred until field evidence demands it.
- **First prepare downloads ~227 MB (INT8)** — the Settings → Voice input section owns that decision with its progress surface.
- **No cross-process asset locking** — two harness processes sharing `$DSH_HOME` may download concurrently; the atomic publish keeps the directory consistent.
