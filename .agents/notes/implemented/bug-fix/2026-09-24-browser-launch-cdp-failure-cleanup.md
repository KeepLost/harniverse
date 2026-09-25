# Agent Note: A failed DevTools handshake leaked the launched browser tree and its profile

Status: implemented

English | [中文](2026-09-24-browser-launch-cdp-failure-cleanup.zh.md)

## Problem

The [browser controller](../../../../packages/api/browser-controller/README.md) launched Chromium, read its DevTools endpoint line, and only then recorded the process handle and profile directory as Session-owned state. If the DevTools socket handshake or the initial target-discovery reply failed — an endpoint that stalls, a race with browser startup, a tight `launchTimeoutMs` — the launch promise rejected through a path that owned neither the spawned tree nor the `mkdtemp` profile: the process kept running and the directory stayed on disk, while the next `create` retried a fresh launch on top of the orphan. The failure surfaced to the panel as a generic `browser-unavailable` with no hint that the browser had in fact started.

## Decision

Process ownership begins at spawn, not at connection. `launchBrowser` hands the caller the `SubprocessHandle` through an `onSpawn` callback before endpoint discovery, and the controller's `owner.live` holds that spawned state — with the profile directory recorded on the Session's discard list the moment `mkdtemp` returns. The launch budget (`launchTimeoutMs`) bounds each startup stage with its full window — first the spawn-to-endpoint-line wait, then the socket handshake and discovery reply — so a slow spawn cannot starve the loopback handshake.

Any failure in that window funnels into one idempotent `shutdownBrowser`: terminate the tree, wait for exit and process-settlement, then remove the profile directories. A cleanup that cannot confirm tree exit or cannot remove a directory reports the original failure together with the cleanup failure and keeps ownership, so a later close or disposal retries the removal and no new launch can replace an unconfirmed tree. The error distinguishes "the browser started but the DevTools connection failed" (with the timeout called out when the budget expired) from launch-time failures, and `CdpConnection.open` reports close-during-handshake separately from error-during-handshake and carries the abort reason as its cause.

## Alternatives considered

Terminating on failure without waiting for exit leaves zombie children under a Chromium process tree and races the profile removal against dying renderers. Deleting the profile immediately and forgetting the handle hides the leak on the happy path but strands both when termination or removal fails. Swallowing cleanup errors after a primary failure would report a clean retry surface while the orphan still holds the user-data-dir lock a relaunch needs.

## Consequences

A Session can no longer outlive a failed launch with an orphaned browser: the tree is stopped and drained before the failure reaches the panel, the profile is removed after settlement, and retries start from a clean directory. The stricter ownership means a pathological tree that refuses to exit blocks relaunch until disposal confirms it — the failure message names both causes rather than silently stacking a second Chromium on the first.

## Testing

[controller.spec.ts](../../../../packages/api/browser-controller/tests/controller.spec.ts) drives the fake browser into endpoint-stall, handshake-refusal, and discovery-silence failures and asserts tree exit, profile removal, ownership retention when cleanup fails, and the relaunch gate; [cdp.spec.ts](../../../../packages/api/browser-controller/tests/cdp.spec.ts) covers close-during-handshake and abort-cause propagation. The focused suites pass 123/123 with 100% statement, branch, function, and line coverage of `cdp.ts`, `index.ts`, and `launch.ts`.
