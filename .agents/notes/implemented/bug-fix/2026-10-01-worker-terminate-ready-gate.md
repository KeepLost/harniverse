# Agent Note: Workflow worker kills wait out the bootstrap window

Status: implemented

English | [中文](2026-10-01-worker-terminate-ready-gate.zh.md)

## Problem

The Windows native lane intermittently died with `[vitest-pool] Worker forks emitted error … exited unexpectedly` inside `workflow-worker-thread.spec.ts`. The crashing spec spawns real workflow workers whose source-mode bootstrap installs tsx transforms and then imports the worker graph; several tests cancel or dispose a run milliseconds after `start()`, so the host's `worker.terminate()` landed while the worker thread was still inside synchronous module loading. A terminate in that window can abort the whole process (the V8 cjs-lexer parse crash, nodejs/node#63323) instead of killing just the thread, which turns a per-run teardown into a dead CI lane.

## Decision

The host never terminates a worker that is still booting. `WorkerRun` keeps one `bootSettled` barrier resolved by the worker's `Ready` handshake or by any first death signal (`error`, `messageerror`, `exit` — past those the thread is no longer inside its synchronous bootstrap). Both kill sites — the cancellation-grace force-settle and `dispose()` — queue behind the barrier through `terminateWorker()`; a 30-second unref'd backstop (`BOOT_KILL_BACKSTOP_MS`) still terminates a wedged boot so a thread can never outlive its run, comfortably above cold tsx startup on a contended runner. The barrier is also released on death signals because message admission closes there first: a late `Ready` would otherwise never reach its own release arm and `dispose()` would always pay the backstop.

## Alternatives considered

- **Bump Node past the upstream abort fix** — rejected: the CI lane crashed on 24.21.0, which already carries nodejs/node#63885, so the observed window outlives that fix; gating the kill is version-independent.
- **Retry the terminate after a crash** — rejected: the crash is a process abort, not a recoverable worker death; nothing remains to retry.

## Consequences

A kill requested during the boot window now fires right after `Ready` (or the thread's own exit), before any `Go` release can be reordered behind it; the regression test pins the Go-before-terminate order through vitest's global `invocationCallOrder` and fails deterministically against the ungated implementation. Disposal stays bounded: the ordinary path resolves with the handshake, and only a never-booting worker costs the backstop.
