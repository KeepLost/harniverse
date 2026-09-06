# Agent Note: Loading-efficiency harvest (A2) — five equivalents, one landed enhancement

Status: implemented

English | [中文](2026-09-06-loading-efficiency-harvest.zh.md)

## Problem

The wave-2 A2 decision takes the loading-efficiency ideas behind the official handle seam and grafts the applicable ones onto Harniverse's coordinator/JSONL backend without replacing the skeleton. The six-item harvest list had to be dispositioned against what the tree already implements before anything was built.

## Decision

Five of the six items are already present or dispositioned; one landed as an enhancement:

- **Header-only stat/list — already present.** `parseHeaderMeta` (`session-persistence-jsonl/src/format.ts`) reads only the first log line for `list`/`listSnapshots`; session pickers scale with session count, not log volume.
- **Validated slice reads — already present as the stronger seq-slice form.** `readFrom(id, fromSeq)` returns the valid contiguous stored suffix (SQLite seeks `WHERE seq >= ?`, JSONL parses forward), and `readHistoryPage`/`readRawEventPage` page by display-message or raw-event budgets over the same validated prefix. The official byte-offset `read(offset, length)` is a weaker spelling of the same capability.
- **Lazy materialization — already present.** `create` registers metadata only; the physical artifact materializes atomically at the first `appendBatch` (`isMaterialized` hook), so an abandoned session leaves nothing on disk.
- **Observe→resume parse memo — already present as the preparation LRU.** The coordinator retains the exact cold unpublished `Session` after `inspect` and reuses it for a later `prepare` while its stored revision is unchanged — the revision-keyed memo is the observe→resume handoff in this architecture.
- **Torn-frame partial decode — landed as an enhancement.** The tree already carried a public one-shot prefix recovery, but it produced empty output at most truncation points and dropped everything on decoder error. The landed form replaces it with a self-contained private-handle streaming prefix decoder (`NodePrivateZstdPrefixDecoder`): 64 KiB drain chunks accumulate plaintext across input exhaustion, a decoder error only halts further decoding while the drained plaintext survives, and recovery granularity is the complete zstd block. Recovered complete JSONL rows flow through the same seq-continuity scanner as normal rows; the JSONL torn marker became the structured `{ truncateTo, recovered }` (still opaque to the coordinator), and `commitRepair` rewrites the recovered rows as their own frame before the closers, each step fsynced.
- **Error-class additions (`SessionReadOnlyError`/`SessionOwnershipLostError`) — deferred for lack of a consumer.** No read-only session state exists yet (archival/import marking arrives with the lossy importer, itself unscheduled), and the kernel lease cannot be lost while held (the kernel releases it at process death — a live holder never observes loss). Building the classes now would be types without a thrower; they land with the features that need them.

## Alternatives considered

**Port the official read(offset,length) byte-slice primitive verbatim.** Rejected: seq-sliced reads over the validated prefix express the same capability at the semantic level callers actually use (event watermarks, page budgets), and byte offsets would couple callers to the physical encoding.

**Add the two error classes now for taxonomy completeness.** Rejected per the package rule that abstractions require a current owner and need; taxonomy follows features, not the reverse.

## Consequences

The harvest closes with one behavioral improvement (block-granularity torn-frame recovery with durable rewrite on repair) and the audit trail documenting why the other five need no change. Evidence: pre-implementation RED (11 failures — `decodeZstdFramePrefix is not a function`, torn-marker assertions) then both persistence suites green — 15 files / 693 tests across `session-persistence` + `session-persistence-jsonl` (baseline 686, +7 new); package `tsc --noEmit` clean; scoped coverage shows zero uncovered positions in `session-persistence-jsonl/src`; the coordinator-contract torn-marker round-trip tests pass unchanged (the structured marker stays opaque to the coordinator).
