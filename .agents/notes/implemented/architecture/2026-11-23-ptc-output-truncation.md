# Agent Note: PTC output truncation without execution cancellation

Status: implemented

English | [中文](2026-11-23-ptc-output-truncation.zh.md)

## Problem

Stopping a program because its captured output exceeded the budget interrupted a sequence of external actions: earlier effects remained, but the caller could not tell which later actions ran, and replaying the program to obtain less output could repeat those effects. A full log budget could also hide a subsequent exception by reclassifying its kind as `output-limit`, and overflow-driven state disposal cleared retained REPL/Script variables for a presentation-only condition. Both the Node provider (child `LogBuffer` → `outputLimit` host RPC; host `OutputLedger` → `admit` overflow) and the Python provider (host-side `capture` on stdout/stderr and `log` frames) shared the terminate-on-overflow semantics.

## Decision

Captured output now has bounded retention on both providers, aligned with the official 0.2.3 `ptc-output-truncation` semantics:

- **Exhaustion preserves an ordered prefix** (the fitting prefix of the overflowing entry included, via the new `OutputLedger.admitPrefix`), discards subsequent output, and sets `PtcRunResult.outputTruncated: true`. It does not cancel execution and does not discard retained variables — the host `outputLimit` RPC from the child now records truncation instead of failing the evaluation, and `RETAINED_STATE_INSTRUCTIONS` no longer lists output overflow among the state-clearing events.
- **Finalization prioritizes the required completion value or the bounded failure diagnostic** within the combined payload budget: logs are cut to make room for a value that fits; a diagnostic that does not fit beside the logs is shortened, never reclassified — truncated diagnostics preserve their failure kind. `output-limit` now means exactly one thing: a required completion value that cannot fit even with an empty log prefix.
- **The child ships whole lossless values and diagnostics bounded to the combined budget** (`prepareCompletion`/`prepareException` dropped their remaining-budget reclassification; frame caps still bound the wire), so the single host ledger owns all combined-budget shaping.
- **The model-visible result carries one bounded notice** (`core/tools/src/ptc.ts`) appended to the captured output — or beside a bounded diagnostic — stating that later output was discarded and execution was not canceled, so the model inspects current state instead of replaying completed actions. Oversized results still settle into `tool-result-artifacts` spill + `artifact_read` paging unchanged.

## Alternatives considered

- **Terminate on output exhaustion** (previous behavior) — turned a presentation limit into interrupted external work without rollback; rejected per the official record.
- **Return success with a truncated completion value** — violates the caller's requirement for complete JSON data; only captured output and diagnostic text may be shortened.
- **Adopt the official `IMAGE_OFFLOAD_REQUIRED`-style fail-and-retry for overflow** — not applicable: truncation needs no retry, and the durable settlement machinery belongs to images, not output.

## Consequences

- Successful truncated runs remain successful tool results naming the truncation; failed runs keep their failure kind with `outputTruncated`. An infinite-looping program with no deadline no longer dies at the log cap — deadlines, cancellation, heap limits, and control-message limits still bound execution, as before.
- The Python provider's `terminalOverride` kill path is gone: `capture` marks truncation and keeps reading; both providers' ledgers share the same accounting shape (kept clone-detection markers).
- Evidence: node suites — `runtime.spec` (truncation without cancel, bounded diagnostic kind, value-cannot-fit boundary), `persistent.spec` (state survives log overflow, parse-diagnostic bounding), `persistent-host`/`host-failures`/`timeout`/`process-main`/`bootstrap`/`output-ledger` updated to the new contract (575 pass); python suites — ledger boundaries, forged-oversized-log recap, diagnostic-priority (50 pass); presenter notice pinned in `core/tools/tests/code-mode.spec` (93 pass).
