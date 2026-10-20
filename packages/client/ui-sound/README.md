# `@deepseek-ai/dsh-client-ui-sound`

English | [中文](README.zh.md)

Sound notifications for the Web UI: a settings section plus an always-on detector that rings six event kinds — completion, approval request, user question, plan review, goal blocked, and failure — each with its own sound and volume, on two independent channels (the main agent and subagents). The node half registers one settings namespace; the browser half owns the whole feature.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-sound
  name: '@deepseek-ai/dsh-client-ui-sound'
```

The plugin injects `slots`, `locale`, `sessions`, `connection`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `sound`, order 75 — after the appearance family, alerting preferences close the personalization group) and its `settings.nav.icon` glyph (key `sound`). The node half registers the durable `ui-sound` settings namespace (schema with defaults); the browser binds that scope and persists every write — master switch, quiet-current, ignore-subagent, and the six sound + six volume fields per channel — through it.

## Detection

The watcher opens one supplementary `events.mux` subscription plus the `events.host` stream through `connection.captureApi()` (a captured API pins a stream to one machine generation; a machine switch breaks it and the backoff loop reopens on the new one), and folds frames into the six kinds:

- **Completion** — `turn/end` with `reason.kind === 'completed'`, or a background job settling `running|stopping → completed`.
- **Failure** — `turn/end` with `reason.kind === 'error'`, a job settling `→ failed`, or a `host/agent-error` frame (failures without a turn position never ride the mux stream).
- **Approval / question / plan review** — `approval/requested` and `question/requested`; the question kind prefers the sessions-list row's settled `pendingInteraction` and falls back to the frame shape (SessionManager's plan-review rules).
- **Goal blocked** — the `goal` projection entering `blocked` (repeated blocked values stay silent).
- **Silent by contract** — aborted, blocked, and `max-tokens` turns; killed jobs; `session/subscribed`, `session/queue`, and resolved frames; and the mux open-burst replay of still-pending requests (refresh recovery) plus any `rpcId` already seen this page life. A `question/resolved` frame re-arms its rpcId.
- **Channels** — an event routes to the subagent channel when its session row is marked `origin: 'subagent'`/`parentId` or the job's kind is `subagent`. Subagent sounds default to mute; `ignoreSubagent` silences the whole channel.

Playback decisions live in one pure router: no sound while the master switch is off, subagent events follow their own fields, and quiet-current mutes only a completion of the session currently open.

## Playback

- **Built-ins** — five synthesized chimes (ding, chime, bell, complete, success) generated live through Web Audio; no audio files ship.
- **Local files** — the section's file picker stores chosen audio in this browser's IndexedDB (`dsh-ui-sound-audio`) and keeps only an opaque `audio:<id>` reference in settings, so blobs never enter the durable document. Unresolvable references stay selected and are labelled as not stored in this browser.
- **Autoplay posture** — file audio decodes through the same lazily-created, gesture-unlocked `AudioContext` the built-ins use, so event-time playback is not subject to the `HTMLAudioElement` autoplay policy. Every playback failure stays silent.
- **Dedupe** — one occurrence's repeated frames ring once (400 ms same-source window, five-minute key retention); with multiple tabs open, a `BroadcastChannel` handshake arbitrates each occurrence to exactly one tab (a lone tab plays immediately, with no handshake).

## Model Experience

None, as sounds play in the browser only; nothing this plugin observes or stores reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Local audio files do not roam** — files live in each browser's IndexedDB, so a settings document synced to another machine keeps the selected `audio:<id>` values but cannot play them there; the section labels such references instead of re-picking. There is no export/import flow (builtin choices roam with the settings document itself).
- **One supplementary mux subscription per tab** — frame-level precision (turn reasons, replay suppression) costs a second mux stream per browser tab next to the runtime's own; the alternative snapshot-diff path cannot distinguish completed from aborted turns.
- **Question classification races the list snapshot** — when a `question/requested` frame arrives before the sessions row settles its `pendingInteraction`, the frame-shape fallback decides; the two rules match, but the row remains the authority.
- **Playback failures are invisible** — autoplay policy, unsupported codecs, a closed context, and missing IndexedDB all degrade to silence without a surface; the section's preview button is the only diagnostic.
- **No per-workspace or quiet-hours policy** — the master switch, quiet-current, and the ignore toggles are the whole gating model; scheduling and per-workspace routing are deferred.
