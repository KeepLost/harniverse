# Agent Note: Desktop window loads settle and the clean-install smoke never parks silently

Status: implemented

English | [中文](2026-10-14-desktop-loadurl-replaced-navigation.zh.md)

- Date: 2026-10-14
- Scope: `apps/desktop` (`src/main.ts`, `src/smoke.ts`, `tests/main.spec.ts`, `tests/smoke.spec.ts`), `.github/workflows/ci.yml` (desktop lane)
- PR: #189 (merge)

## Problem

Two `desktop / Windows x64` CI runs (only this lane, ~4% of its runs) failed the clean-install smoke with `timedOut=true`: the packaged app authenticated and served the full plugin traffic within ~25 seconds, then produced no output at all — no renderer polling, no host logs, no smoke error — until the driver's outer 300-second kill. The captures ruled out every deadline-bounded helper (each throws and prints): the process was either parked on an await with no bound or its main loop was frozen, and the two classes are indistinguishable from a dead-silent log. Static review found one provable latent bug in the parked-await class: the shell awaited `window.loadURL(url)` directly at four sites, and Electron ties that promise to the first navigation's `did-finish-load` — a navigation replaced mid-load (the warm-session reconnect redirect) never settles it, freezing the serialized operation chain forever.

## Decision

- **`loadWindow(window, url, deadlineMs = 60_000)` fronts all four `loadURL` sites** (initial connect, launcher after disconnect or failure, browser-bootstrap completion, the tray's open-app item). Success settles when the promise resolves **or** the main frame's `did-navigate` reaches the target origin — the replaced-navigation case; a main-frame `did-fail-load` rejects immediately; the deadline rejects a genuinely stuck load so the existing failure and retry paths stay reachable. A RED-verified regression test pins the never-settling navigation (the old code hangs the test; the new code completes the connect).
- **The smoke qualifies loudly instead of silently.** Every shell-lifecycle await in `DesktopCleanInstallSmoke.run` (first connect, disconnect, restart connect, quit) runs through `boundedSmokeStep` with a 100-second budget, and a 10-second unref'd heartbeat logs `T+Ns step=<name>` to the captured stdout. A parked step — including a modal dialog the unattended runner can never answer — now fails the qualification in ~100 seconds naming the step, instead of eating the outer 300-second kill in silence; and the heartbeat beside a parked step proves main-loop liveness, while stopped heartbeats prove a frozen loop. That distinction is the missing evidence to fix any residual app-side trigger at its root.
- **The most probable environmental trigger is excluded.** The desktop lane adds the build output tree to Windows Defender's real-time exclusions before packaging: the just-signed, ~300 MB unpacked binary is scanned precisely during the smoke's first launch, and a scan storm on a 2-core hosted runner can stall the fresh process past any step deadline.

## Alternatives considered

- Treating the failure as a runner flake and rerunning. Rejected by owner direction: the job had passed on identical code twice, both captures showed the same boot-then-silence signature, and one provable bug sat on every user's reconnect path.
- Raising the smoke's outer budget again. Rejected: the budget was already 300 s for exactly this cold-Windows reason; a longer silent wait hides the failure class instead of naming it.
- Auto-answering or bounding the shell's dialogs in production. Rejected: a quit warning must wait for a real user by design; the smoke-side step budget is the unattended-context contract, and it fails the qualification rather than impersonating a user.

## Consequences

A warm-session reconnect can no longer freeze the shell on a replaced navigation, and a genuinely stuck load surfaces within a bounded 60 seconds. The clean-install smoke fails fast and loud at the exact parked step with heartbeat evidence, and the Defender exclusion removes the most likely stall source on the flaky lane. `apps/desktop` sits outside the `packages/*/*/src` per-file coverage gate, but the new logic carries unit tests (the budget race with fake timers, the RED-verified navigation regression, and the drain of the fatal-recovery dialog). If the signature ever recurs, the capture will name the step and prove liveness or its absence — the input the two silent captures lacked. No wire, storage, or model-visible contract changes.

Verification: `apps/desktop/tests` 194 passed (main, smoke, owned-process, fatal-recovery suites), packaging TypeScript check, scoped oxlint, and full PR CI after the change.
