# `@deepseek-ai/dsh-client-ui-sound`

English | [中文](README.zh.md)

Sound notifications for the Web UI: a settings section plus an always-on consumer of host-routed occurrences that alerts on six event kinds — completion, approval request, user question, plan review, goal blocked, and failure — each with its own sound and volume, on two independent channels (the main agent and subagents). The host detects each occurrence once and routes it as a `session/notify` frame to the page that currently has the session open (`events.adopt` presence); other pages stay silent and a session no page adopted is not delivered. Every alert rides the browser's system notifications: the sound is part of the notification, so an unsupported or denied Notifications permission silences the alert entirely, and a visible focused tab skips the toast while the sound still plays. The node half registers one settings namespace; the browser half owns the whole feature.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-sound
  name: '@deepseek-ai/dsh-client-ui-sound'
```

The plugin injects `slots`, `locale`, `sessions`, `connection`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `sound`, order 75 — after the appearance family, alerting preferences close the personalization group) and its `settings.nav.icon` glyph (key `sound`). The node half registers the durable `ui-sound` settings namespace (schema with defaults); the browser binds that scope and persists every write — master switch, quiet-current, ignore-subagent, and the six sound + six volume fields per channel — through it.

## Occurrences and routing

Detection lives on the host: one central fold over the live sources (durable `turn/end` reasons, requested approvals and questions — once per rpcId until resolved, background-job terminal edges, the `goal` projection's blocked entry, and live agent errors) turns each occurrence into a `session/notify` frame. Delivery follows page presence: the runtime declares the page's open session through `events.adopt`, and the most recent declarer's live mux streams receive the frame — every other page (and every page of another browser) stays silent, and a session with no adopting page is not delivered at all. The detection contract this mirrors:

- **Completion** — `turn/end` with `reason.kind === 'completed'`, or a background job settling `running|stopping → completed`.
- **Failure** — `turn/end` with `reason.kind === 'error'`, a job settling `→ failed`, or a live agent error (failures without a turn position never ride the mux stream).
- **Approval / question / plan review** — requested approvals and questions; the question kind prefers the sessions-list row's settled `pendingInteraction` and falls back to the frame shape the frame carries (SessionManager's plan-review rules).
- **Goal blocked** — the `goal` projection entering `blocked` (repeated blocked values stay silent).
- **Silent by contract** — aborted, blocked, and `max-tokens` turns; killed jobs; resolved requests; the mux open-burst replay never reaches the central fold, and a resolved rpcId re-arms.
- **Channels** — an occurrence routes to the subagent channel when its session row is marked `origin: 'subagent'`/`parentId`. Subagent sounds default to mute; `ignoreSubagent` silences the whole channel.

The watcher itself keeps only the stream machinery: one supplementary `events.mux` subscription through `connection.captureApi()` (a captured API pins a stream to one machine generation; a machine switch breaks it and the backoff loop reopens on the new one), reopen backoff, and the carrier breaker. Playback decisions live in one pure router: no alert while the master switch is off, subagent events follow their own fields, and quiet-current mutes only a completion of the session currently open.

## Notification

The notifier mirrors the OpenCode web behavior: the first alert on a `default` permission triggers one `Notification.requestPermission()` prompt (concurrent alerts share the in-flight request; a rejected prompt reads as denied), and only a granted permission delivers. On delivery the chime plays and — unless the tab is visible and focused — a system toast appears with the localized event title and the session's display title; activating the toast focuses the window and opens that session. The toast claims `silent` where honored (the alert's own chime is the sound); host-side single-owner delivery already guarantees exactly one presenting page per occurrence, so no tab-to-tab arbitration remains.

## Playback

- **Built-ins** — five synthesized chimes (ding, chime, bell, complete, success) generated live through Web Audio; no audio files ship.
- **Local files** — the section's file picker stores chosen audio in this browser's IndexedDB (`dsh-ui-sound-audio`) and keeps only an opaque `audio:<id>` reference in settings, so blobs never enter the durable document. Unresolvable references stay selected and are labelled as not stored in this browser.
- **Autoplay posture** — file audio decodes through the same lazily-created, gesture-unlocked `AudioContext` the built-ins use, so event-time playback is not subject to the `HTMLAudioElement` autoplay policy. Every playback failure stays silent.
- **Dedupe** — one occurrence's repeated frames ring once (400 ms same-source window, five-minute key retention); delivery already arrives on exactly one page, so the window only guards duplicate host pushes.

## Model Experience

None, as sounds play in the browser only; nothing this plugin observes or stores reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Local audio files do not roam** — files live in each browser's IndexedDB, so a settings document synced to another machine keeps the selected `audio:<id>` values but cannot play them there; the section labels such references instead of re-picking. There is no export/import flow (builtin choices roam with the settings document itself).
- **One supplementary mux subscription per tab** — receiving routed occurrences costs a second mux stream per browser tab next to the runtime's own; the alternative (reading notifications off the runtime's stream) would couple the alert loop to the object layer's frame dispatch.
- **Sessions with no adopting page stay silent** — a background session no page has open is, by owner decision, not delivered anywhere; relaxing this needs a host-side fallback policy (for example a last-known-owner lease), not a client change.
- **Question classification races the list snapshot** — when a `session/notify` frame arrives before the sessions row settles its `pendingInteraction`, the frame-shape fallback decides; the two rules match, but the row remains the authority.
- **Playback failures are invisible** — autoplay policy, unsupported codecs, a closed context, and missing IndexedDB all degrade to silence without a surface; the section's preview button is the only diagnostic.
- **No per-workspace or quiet-hours policy** — the master switch, quiet-current, and the ignore toggles are the whole gating model; scheduling and per-workspace routing are deferred.
- **Permission state has no in-section surface** — a denied notification permission silences alerts with no banner or re-prompt button in the settings section (the browser's own site-settings UI is the recovery path); a permission prompt without a user gesture is also Safari's documented denial path, so first alerts there stay silent.
