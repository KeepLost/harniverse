# @deepseek-ai/dsh-speech-settings

English | [中文](README.zh.md)

Root-owned settings namespace for voice input: the `speech` section of `$DSH_HOME/settings.yaml` (hot-reloaded) persists the recognizer choice, language hint, push-to-talk key, local model precision, and the cloud API key — and every committed change is pushed into `ctx.speech`, so consumers and providers read one live preference source.

## Fields

| Field | Schema | Default |
| --- | --- | --- |
| `recognizer` | `'off' \| 'sensevoice' \| 'openai-compatible'` | `'off'` |
| `language` | string (2–35) | unset (auto-detect) |
| `pushToTalkKey` | string (1–32), lowercased by the UI | unset (gesture disabled) |
| `modelVariant` | `'int8' \| 'fp32'` | `'int8'` |
| `apiKey` | string, `role('secret')` — write-only on every wire surface | unset |

The namespace registers `applies: 'live'` with a composition `base` layer (the plugin's own cordis.yml config), so an overlay can pin deployment defaults while user edits win. The plugin `inject`s `['settings', 'speech']`; the bridge effect (`scope.watch → ctx.speech.configure`) rides the plugin fiber, and unregistering the namespace stops the pushes.

The web client reaches this namespace through `settings.describe` / `settings.mutate` (the gateway's `WEB_SETTINGS_NAMESPACES` allowlist names `'speech'`), so the Settings → Voice input section and the Plugins page edit the same document.

## Model Experience

### Recognizer preference persistence

#### What the model sees

The namespace stores which `recognizer` answers `speech.transcribe`; the model never reads the setting.

#### Token effect

None; the recognizer contributes no tokens — only its returned text can reach a draft.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Recognizer ids are a closed schema union** — a new provider edits this schema beside its package; an open id union would admit typos as silently-broken selections.
- **One global key** — per-session or per-provider credentials are deferred with the cloud provider's multi-gateway work.
