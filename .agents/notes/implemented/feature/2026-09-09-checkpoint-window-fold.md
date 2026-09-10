# Agent Note: Windowed checkpoint resume — surface fold and session restore

Status: implemented

English | [中文](2026-09-09-checkpoint-window-fold.zh.md)

## Problem

After a context reset, a cold open still parses and folds the entire durable log, although every surface node below the last checkpoint is dead weight: the reset marker replaced it. Track C of the reset/schedule plan is general checkpoint resume — the log stays complete and searchable while the model-facing surface is derived from a window that starts at the checkpoint.

## Decision

`SurfaceManager` (packages/core/session/src/surface.ts) now folds a windowed log whose first replacement predates the window. When `baseSeq > 0`, the fold state is still empty, and a `replace` op has both endpoints below `baseSeq` with `start <= end`, the range resolves as a historical replace: the empty-state splice inserts the marker at the front, so the windowed fold's node list equals the full fold's exactly. From-0 folds cannot reach the branch, and provenance plus the durable anchor-adjacency invariant still hold on the complete log (the context-reset companion enforces them). `packages/context/context-reset/tests/checkpoint-window.spec.ts` pins the equivalence kernel: the same nodes and identical derived message payloads, whether the manager reads the whole log, the window from the anchor, or the window from the marker alone.

The session seam has landed with the same shape the plan sketched: `Session.fromRestore` (packages/core/session/src/index.ts) adopts a windowed seed when the snapshot at seed index 0 carries `seq > 0` — and only there, so snapshot-mode seeds still require seq 0 and a windowed restore is the sole adoption path. The window's `baseSeq` becomes a constructor fact of the instance: contiguity is validated as `baseSeq + index`, `append` assigns absolute seqs, `get seq()` reports the window base plus the log length, `firstLiveSeq` stays the in-process construction boundary, and the derived-message lookup walks absolute node seqs. The single-read seed getter contract is preserved: `baseSeq` is learned from the already-read first snapshot, never by re-reading the seed. `checkpoint-window.spec.ts` grew the Session-level equivalence kernel: a windowed `fromRestore` yields `deriveMessages()` equal to a full-log restore, contiguous absolute appends, and rejects a window in snapshot mode.

SQLite checkpoints store the surface after the last completed turn preceding a replacement, including partial compaction replacements. A physical-prefix SHA-256 hash binds the stored header, database identity, session incarnation, boundary, and surface state through the replacement event. The coordinator accepts the window only with a valid checkpoint, an intact tail, and absolute event lookup; otherwise it uses `loadStored`. The prepared Session resolves `eventAt()` on demand, while `eventsFrom()` supplies resident suffixes for attachment and projection hydration. Reading `events` explicitly materializes a complete, frozen, independent array; a caller-held snapshot remains readable after backend closure. Windowed Sessions weakly cache that array and historical payloads, while non-windowed Sessions strongly cache the array. Explicit `load()` and `inspect()` also return detached, frozen history usable after backend closure. Request-header/context consumers back-seek as needed; Agent inbox replay reads complete history so pre-window pending messages survive.

The projection registry accepts an identity- and version-checked cache checkpoint and folds the resident tail exactly once. A stale or incomplete projection row is a cache miss and cannot make restore fail. The acceptance evidence is a cold open whose `deriveMessages()` and complete raw event view remain equivalent to full replay, with hash mismatch, malformed checkpoint, torn-tail, and append-continuity coverage.

## Consequences

The canonical log remains complete and append-only. Partial replacements require the validated pre-boundary surface state and historical resolver; a marker-only fold does not prove arbitrary-cut equivalence. Hash verification still scans physical prefix bytes but avoids decoding their payloads. Weak references let historical payloads without other strong references be collected after consumers release snapshots; the `Map<number, WeakRef<SessionEvent>>` metadata still grows with accessed historical sequences. Full-history consumers, including Agent inbox replay, still materialize the prefix synchronously and incur its peak allocation, so this implementation does not guarantee strictly bounded total memory for an assembled Agent. JSONL retains complete loading.

## Alternatives considered

Rebasing the window to seq 0 is rejected: absolute seqs are durable identifiers used by sourceEventSeqs, display history, and provenance. A reset-only optimization cannot cover partial compaction replacements that retain earlier nodes; storing pre-boundary surface state and resolving those nodes preserves the generic replacement contract.
