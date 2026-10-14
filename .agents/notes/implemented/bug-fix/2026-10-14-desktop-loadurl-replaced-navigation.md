# Agent Note: Desktop window loads settle even when a navigation is replaced

Status: implemented

English | [中文](2026-10-14-desktop-loadurl-replaced-navigation.zh.md)

- Date: 2026-10-14
- Scope: `apps/desktop` (`src/main.ts`, `tests/main.spec.ts`)
- PR: #189 (merge)

## Problem

One `desktop / Windows x64` CI run failed its clean-install smoke with `timedOut=true`: the packaged app authenticated and served the full plugin traffic within 25 seconds, then produced no output for the remaining ~4.5 minutes until the smoke's outer 300-second kill. Every smoke-side poll loop was already deadline-bounded, and every owned-Host deadline escalates — so the stall had to sit in an await with no bound. The desktop shell awaited `window.loadURL(url)` directly at four sites (initial connect, the launcher after disconnect or failure, the browser-bootstrap completion, the tray's open-app item). Electron ties `loadURL`'s promise to the first navigation's `did-finish-load`; when that navigation is replaced mid-load — exactly what a warm-session reconnect does, when the authentication redirect supersedes the initial load — the promise never settles. The shell's serialized operation chain then blocks forever: every later connect, disconnect, or quit queues behind the stalled transition, leaving a fully-booted yet inert app with no error and no exit. Cold Windows runners merely widen the race window; the same freeze could hit a real user's reconnect.

## Decision

One private `loadWindow(window, url, deadlineMs = 60_000)` now fronts all four `loadURL` sites. Success settles when the `loadURL` promise resolves **or** the main frame's `did-navigate` reaches the target origin — the replaced-navigation case, where any landing at the right origin is proof the shell moved on. A main-frame `did-fail-load` rejects immediately, and a 60-second deadline rejects a genuinely stuck load so the existing failure and retry paths (fatal recovery dialog for owned-Host connects, the launcher failure state otherwise) stay reachable instead of an eternal spinner. Listeners are always removed on settle. Two regression tests pin the contract: a replaced navigation whose `loadURL` promise never settles still completes `connect` (verified RED first — on the old code the test hangs until its own timeout), and a main-frame load failure rejects through the retry error into the recovery dialog, with the un-awaited recovery drained inside the test so no later test inherits its `app.quit()`.

## Alternatives considered

- Bounding only the smoke's outer budget or retrying the flaky job. Rejected: the job had passed twice on identical desktop code, the capture showed a healthy-but-inert app, and the same unbounded await sits on every user's reconnect path; the rerun treated the symptom.
- A general navigation watchdog outside the shell. Rejected: the freeze is precisely the `loadURL` await contract; the fix belongs at the four await sites, not in a second observer that would race the shell's own state machine.

## Consequences

A warm-session reconnect can no longer freeze the shell on a slow machine, and a genuinely stuck load surfaces the existing failure flow within a bounded 60 seconds. `apps/desktop` sits outside the `packages/*/*/src` per-file coverage gate, but the new branches are exercised by the two regression tests. The clean-install smoke keeps its outer kill as a last resort; with this fix the failure mode it caught is unreachable. No wire, storage, or model-visible contract changes.

Verification: `apps/desktop/tests` 192 passed (34 in `main.spec.ts`, including the RED-verified regression pair), scoped oxlint clean, full PR CI green after the fix landed.
