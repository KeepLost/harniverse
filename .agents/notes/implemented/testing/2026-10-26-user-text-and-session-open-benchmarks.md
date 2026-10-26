# Agent Note: The user-text and session-open benchmarks

Status: implemented

English | [中文](2026-10-26-user-text-and-session-open-benchmarks.zh.md)

## Problem

The wave-3 benchmarks decision accepted regression-driven performance gates at user-lifecycle endpoints whose cost scales with accumulation, with budgets as reviewed source constants; wave-4 landed the tree with the terminal gate, and the browser and streaming gates followed. The wave-5 survey recorded official's benchmarks expansion (row 11) as the already-approved direction gaining concrete shape.

## Decision

Extend the benchmarks tree with two gates (owner decision 2026-10-26), each in the tree's established style — synthesized inputs from reviewed constants, serial samples, median aggregates, an absolute budget asserted after the report line, and the `run-benchmark.ts` process-tree RSS ceiling:

- `benchmarks/user-text.bench.ts` — the credential matcher behind sent-user-text masking, over five unmatched document shapes (typical messages, prose, code, JSON, base64, each ~256 KiB or message-batch sized) and two matched shapes (one model key or GitHub token per message, 200 messages). Every document is scanned to its end through advancing-offset queries. Budget: 10 ms median per document (measured: under 1 ms). The gate exists so a backtracking regression in the recognizer cannot land silently.
- `benchmarks/session-open.bench.ts` — cold restore of a large session: one synthetic log of 2,000 turns (8,000 events) built once through the production append path, then `Session.fromRestore` plus `deriveMessages()` measured per sample. Budgets: restore 100 ms, derive 25 ms (measured: ≈8 ms and ≈0.5 ms). The fold over a growing log is the accumulation cost every session open pays; disk I/O belongs to the persistence packages' own tests.

Both join the CI matrix as required `performance / user text` and `performance / session open` jobs, beside the existing terminal, browser, and streaming gates.

## Alternatives considered

**Port official's machine-profile scaling and worker framework.** Our tree already has its own sample/median/RSS discipline and runs on one Linux runner class; the scaling-report machinery answers a variance problem we do not have at these budgets.

**Session-open through the full JSONL persistence read.** The benchmark must exercise a production path, but bundling the coordinator, fsync, and zstd decode would measure the filesystem as much as the fold; the restore kernel is the part that scales with history length.

## Consequences

- The matcher and the restore fold each have a named, budgeted regression gate; budgets change only by editing the reviewed constants in this file's owning benchmark.
- Verification: both benchmarks pass locally (medians reported above); the CI workflow spec validates the new jobs and the required-gates graph.
