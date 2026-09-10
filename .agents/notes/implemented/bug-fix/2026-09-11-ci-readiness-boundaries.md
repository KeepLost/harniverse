# Agent Note: Observe owned readiness before config refresh and browser assertions

Status: implemented

English | [中文](2026-09-11-ci-readiness-boundaries.zh.md)

## Problem

A watcher handle or mounted UI does not prove that asynchronous input is observable. An exact config registration can miss its only creation while a native subscription is starting; two equal accessibility snapshots can both contain loading placeholders. Cordis approval also injects model-visible context after the initial request settles, so the test cannot treat the run request, approval continuation, and explicit stop prompt as two interchangeable turns.

## Decision

### Exact config observation

[HMR `registerConfig`](../../../../vendor/hmr/src/index.ts) resolves one exact path through its nearest existing canonical ancestor and captures an asynchronous stat baseline before effect-owned registration returns. It polls that path independently of native events, `usePolling`, module roots, and directory scans. Each poll schedules the next after its stat settles, using `interval` or 100 ms; the unreferenced timer does not keep the process alive. Existing files request one initial refresh; missing files and parents remain observable when created later.

Snapshots compare device, inode, size, nanosecond mtime, and nanosecond ctime, not atime. `ENOENT` and `ENOTDIR` mean absence. Other baseline failures reject registration; later stat failures warn and preserve the prior baseline for retry. Duplicate canonical registrations are rejected, including concurrent aliases. Disposal during baseline acquisition rejects with `INACTIVE_EFFECT` without admitting work.

Cordis effects own cleanup before an initial refresh can dispose its owner. Registration or HMR disposal stops polling, joins a pending stat, and drains already-admitted serialized/coalesced refresh work; a late stat completion admits no new refresh. Refresh failures still normalize to `Error` and broadcast `hmr/config-update-failed`, and rejecting observers cannot stop later updates. The main Chokidar module/Include watcher retains its configured native-or-polling behavior and `ignoreInitial: true`; no launcher, bundle, or agent-loop special case replaces the plugin lifecycle.

### Browser and replay readiness

[`captureStableAria`](../../../../apps/web/tests/scaffold.ts) settles React rendering only after the caller observes scenario data readiness. The [lifecycle command-menu scenario](../../../../apps/web/tests/lifecycle-chrome.e2e.ts) waits for the loaded compact command option; the [parent-offline subagent scenario](../../../../apps/web/tests/subagent-interrupt-ui.e2e.ts) waits for the fetched `partial` history text. Both retain their existing goldens, rather than accepting loading output.

The [Cordis scenario](../../../../apps/web/tests/cordis-tool-round.e2e.ts) selects its own Session by the initial prompt and waits for each durable `turn/end`, Agent idle state, and Session flush. Approval follows completed turn 1; the host-runner context starts an independent turn 2; the explicit stop prompt follows completed turn 2 and precedes `cordis_stop` in turn 3. Assertions require all three turns to complete and all four tool results to succeed before comparing or refreshing the golden.

The recorded fixture has six model requests; consuming the stop responses for the approval continuation exhausts it at request seven. A [replay-only sidecar](../../../../apps/web/tests/snapshots/cordis-tool-round/replay.override.json) supplies `CORDIS_UI_RUNNING` as the approval acknowledgement and shifts the stop call and final reply one request later. The JSONL remains an unchanged real-model recording. The [corrected golden](../../../../apps/web/tests/snapshots/cordis-tool-round/ui.expected.md) removes the previously accepted exhaustion error under stronger ordering and completion assertions, not weaker expectations.

## Alternatives considered

**Wait longer or keep writing until a watcher responds.** Neither proves that the first single write survives native subscription startup. Owning the stat baseline removes that dependency for exact config paths.

**Treat equal ARIA samples as I/O readiness or refresh loading goldens.** Stable placeholders say nothing about pending command/history responses. Scenario-owned content provides the missing condition without sleeps or changed product output.

**Reuse the two-turn replay or inspect only the final completion.** Approval can consume stop responses before the user requests a stop; a later failure can even become accepted snapshot output. An explicit acknowledgement and every-turn/order assertions preserve the real approval action and expose script exhaustion.

## Consequences

Exact-path polling trades native event dependence for one asynchronous stat per registered path per interval after the preceding stat settles. It coalesces observable states, not every intermediate write: creation and removal entirely between polls, or changes indistinguishable in the selected stat fields, are not guaranteed notifications. Broad module watching is not converted to polling. Browser readiness stays local to each scenario; the replay acknowledgement is synthetic and does not claim a fresh live-model recording.

## Testing

The [exact-config regressions](../../../../packages/boot/app-boot/tests/hmr-config.spec.ts) pin a single creation across delayed native startup, missing-parent creation, canonical alias exclusion, stat-field/error recovery, non-overlapping polls, and registration/owner disposal with no late work. [User-patch composition coverage](../../../../packages/boot/app-boot/tests/user-patches.spec.ts) exercises addition, invalid-edit retention, recovery, and removal without Chokidar settling sleeps.

The diagnostic browser experiment with temporary one-second HTTP delays reproduced six test failures plus two teardown errors; the same delays with the data-ready waits passed 10/10 tests. Those diagnostic delays are removed. This evidence distinguishes missing readiness conditions from intended UI changes; it is not a new timing threshold or a cross-platform browser guarantee.

## Related decisions

This note partially supersedes the exact-path mechanism in [config hot-reload resilience](2026-07-20-config-hot-reload-resilience.md) and [initial-scan boot safety](2026-08-03-hmr-initial-scan-boot-deadlock.md), and clarifies the settled-capture assumption in the [keyless browser lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md). Those records remain active: compensating rollback, Include serialization and its failing-apply gap, and real-composition replay ownership still constrain current behavior. The [subagent interrupt](../feature/2026-08-06-continuable-subagent-interrupt.md) and [compare-only CI](../testing/2026-07-30-web-browser-snapshot-ci-gate.md) decisions remain unchanged; no predecessor is fully superseded or archived.
