# Agent Note: Browser sound notifications over a supplementary mux subscription

Status: implemented

English | [中文](2026-10-19-ui-sound-notifications.zh.md)

## Problem

The web GUI had no notification sound: a turn finishing in a background tab, an approval waiting, a goal stuck, or a job failing were all silent unless the reader happened to look. The community plugin `@ai-galaxy/dsh-sound` (third-party) demonstrates the demand on the stock runtime with localStorage persistence and no first-party settings path; Harniverse wanted the same capability as a first-class plugin over its own contracts — the `ui-sound` settings namespace exposed to browsers, the sessions list, and the frame streams.

## Decision

One browser-only plugin package, `packages/client/ui-sound`, split along three seams:

- **Durable preferences ride the settings namespace** (`ui-sound`, registered by the node half, allowlisted for browsers in `dsh-host-apiproxy`). The scope carries the master switch, quiet-current, ignore-subagent, and per-kind sound + volume fields for both channels. Local audio blobs never enter the document: the section stores them in per-browser IndexedDB (`dsh-ui-sound-audio`) and persists only opaque `audio:<id>` references. This replaces the community plugin's localStorage backend with the first-party roaming path opened for `mcp`.
- **Detection is frame-level, not snapshot-level.** The watcher opens one supplementary `events.mux` subscription plus the `events.host` stream per tab through `connection.captureApi()` (machine-generation pinned), because turn settlements need the durable `turn/end` reason: aborted, blocked, `max-tokens`, and killed transitions must stay silent, and the mux open-burst replay of still-pending approvals/questions must not ring on refresh. Requested frames ring once per `rpcId`; `question/resolved` re-arms its id. Question classification prefers the sessions-list row's settled `pendingInteraction` and falls back to SessionManager's frame-shape plan-review rules. Jobs ring on the `running|stopping → terminal` edge; the goal projection rings only on entry into `blocked`.
- **Playback decisions are one pure router.** `resolvePlayback(settings, occurrence, currentSession)` answers whether and what to play — the master switch, the subagent channel's own fields and `ignoreSubagent`, and quiet-current (only a completion of the currently open session). The engine owns synthesis (five Web Audio built-ins), file playback through the same gesture-unlocked `AudioContext` (immune to the element autoplay policy), same-source dedupe (400 ms window, five-minute key retention), and cross-tab arbitration over a `BroadcastChannel` (a lone tab plays immediately; peers defer by nonce so exactly one tab rings).

The section (id `sound`, order 75) follows the settings-section standard: four-shares props, the scope bound through the inject `hooks` compartment, optimistic overrides until writes land, and CSS Modules over `--dsw-*` tokens with the elevated-surface scrollbar rebind.

## Verification

- `packages/client/ui-sound/tests/watcher.client.spec.ts` covers every frame kind, silence rule, channel route, burst/rpcId discipline, reopen backoff, and disposal (23 tests).
- `routing`/`engine`/`cross-tab`/`audio-library`/`pick-file` suites cover the router table, synthesis and file paths, arbitration, the IndexedDB adapter (including upgrade, blocked, failed, and aborted opens), and the picker lifecycle.
- `apply`/`components`/`locales`/`invariant` suites cover registration and HMR disposal, the section's presentation behavior, dictionary parity, and the invariant companion (110 tests package-wide, per-file 100 % coverage).
- `ui-primitives` gained `IconVolumeOutline16` (icon-set count spec updated); the scrollbar-rebind spec covers the new stylesheet.

## Alternatives considered

**Sessions-list snapshot diffing (no second stream).** Reading `running` edges and `pendingInteraction` from the runtime's own snapshot needs no extra subscription, but a `running → false` edge cannot distinguish `completed` from `aborted`/`max-tokens`, so user cancellations would ring as completions. The community plugin accepted exactly this trade-off in its fallback path; the first-party version did not.

**Host-side notification envelopes (`dsh-notification`).** The outbound notification service already models turn settlement, but its consumers are external backends over `ctx.notification`; a browser sound would still need a client channel, and the envelope vocabulary carries no per-tab dedupe key. Rejected as a roundabout path to frames the browser already receives.

**First-party scope now, import bridge later.** The plugin's sound vocabulary matches the community plugin's, so a future settings importer could translate a `dsh-sound:config` localStorage blob; deferred until someone actually migrates.

## Consequences

- Every browser tab holds one extra mux subscription (frame duplication next to the runtime's own stream); bounded by tabs, and the reopen loop backs off exponentially.
- Local audio files are per-browser by construction; roaming machines see labelled, unplayable references (documented in the package README).
- The `ui-sound` namespace joins `WEB_SETTINGS_NAMESPACES`; any future settings-export tooling picks the section up for free.
- `IconVolumeOutline16` is the first sound glyph in the primitive set; later audio-adjacent surfaces should reuse it.
