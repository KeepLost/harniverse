# Agent Note: Classifying and retrying the Vitest fork-teardown race

Status: implemented

English | [中文](2026-10-14-vitest-teardown-race-retry.zh.md)

## Problem

The native Windows and macOS coverage lanes failed intermittently with `Error: [vitest-pool]: Worker forks emitted error` / `Caused by: Error: Worker exited unexpectedly` while the same run reported every test file and test passing (for example 1309 files, 20 652 tests, zero failures). Three of six recent dev commits hit it on `windows node 24 / native complete`, under two different worker budgets (2 and 1) and with the lane's heap headroom already raised — worker count, concurrency, and heap showed no correlation with survival. A macOS run showed the same class as a harmless stderr line while its suite passed, confirming the noise and the crash share one upstream root.

## Decision

**Treat the signature as infrastructure, not product, and retry it once — classified, bounded, and observable.** `scripts/run-gates.ts` gains `Gate.retryOn(result)`, a predicate evaluated on a failed execution; a matching gate returns to the scheduler queue exactly once, and the runner prints `run-gates: RETRY <label>` so the retry is visible in every log. The instrumented `test:coverage` gate classifies with `isVitestTeardownRace`: the pool must report `Worker exited unexpectedly`, every `Test Files` summary line must show a run with no failed tests, and any real test failure disqualifies the retry. The predicate lives with the gate runner so every lane using `coverageGates()` (Linux, Windows, macOS) inherits the same protection.

Root cause, for the record: tinypool's process pool cannot distinguish a fork that exited after finishing every task from one that crashed mid-task — `ProcessWorker.onUnexpectedExit` raises `Worker exited unexpectedly` for both, which several upstream projects observe as a shutdown-time race on loaded machines. Until the exit code and the idle/crash distinction land in a Vitest release (tinypool has an `allowWorkerIdleExit` proposal upstream), a classified single retry is the honest remedy: it never masks a failing test, it bounds itself to one rerun, and it logs when it fires.

## Alternatives considered

**More scheduling knobs (fewer workers, lower concurrency, bigger heaps).** Rejected by evidence: the race reproduced with one instrumented worker on an otherwise-quiet box; the knobs only slow the lanes.

**Upgrading Vitest.** Rejected for now: 4.1.11 is the end of the 4.1 line and 5.0 is a mid-PR major upgrade; revisit when the pool exit-code reporting ships.

**Ignoring the unhandled error.** Rejected: the exit code is the gate contract and the same signature could one day carry a real defect.

## Consequences

A teardown race now costs one coverage rerun (visible as a `RETRY` line) instead of a red lane whose tests all passed. Real test failures, spawn errors, and non-coverage gates behave exactly as before — `retryOn` is opt-in per gate and nothing else sets it. The upgrade trigger is explicit: when Vitest exposes worker exit codes or an idle-exit mode, replace the retry with that signal.

Verification: `scripts/run-gates.spec.ts` covers the retry contract — a matching signature reruns once and passes; a matching signature that fails again stays failed after its single retry; a failure reporting failed tests never retries. The existing scheduler graph tests (dependency skipping, worker-count validation, coverage ordering) stay green; scoped oxlint over the changed files.

PR: #189 (merge)
