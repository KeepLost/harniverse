# Agent Note: Windowed checkpoint resume — surface fold and session restore

Status: implemented

English | [中文](2026-09-09-checkpoint-window-fold.zh.md)

## Problem

After a context reset, a cold open still parses and folds the entire durable log, although every surface node below the last checkpoint is dead weight: the reset marker replaced it. Track C of the reset/schedule plan is general checkpoint resume — the log stays complete and searchable while the model-facing surface is derived from a window that starts at the checkpoint.

## Decision

`SurfaceManager` (packages/core/session/src/surface.ts) now folds a windowed log whose first replacement predates the window. When `baseSeq > 0`, the fold state is still empty, and a `replace` op has both endpoints below `baseSeq` with `start <= end`, the range resolves as a historical replace: the empty-state splice inserts the marker at the front, so the windowed fold's node list equals the full fold's exactly. From-0 folds cannot reach the branch, and provenance plus the durable anchor-adjacency invariant still hold on the complete log (the context-reset companion enforces them). `packages/context/context-reset/tests/checkpoint-window.spec.ts` pins the equivalence kernel: the same nodes and identical derived message payloads, whether the manager reads the whole log, the window from the anchor, or the window from the marker alone.

The session seam has landed with the same shape the plan sketched: `Session.fromRestore` (packages/core/session/src/index.ts) adopts a windowed seed when the snapshot at seed index 0 carries `seq > 0` — and only there, so snapshot-mode seeds still require seq 0 and a windowed restore is the sole adoption path. The window's `baseSeq` becomes a constructor fact of the instance: contiguity is validated as `baseSeq + index`, `append` assigns absolute seqs, `get seq()` reports the window base plus the log length, `firstLiveSeq` stays the in-process construction boundary, and the derived-message lookup walks absolute node seqs. The single-read seed getter contract is preserved: `baseSeq` is learned from the already-read first snapshot, never by re-reading the seed. `checkpoint-window.spec.ts` grew the Session-level equivalence kernel: a windowed `fromRestore` yields `deriveMessages()` equal to a full-log restore, contiguous absolute appends, and rejects a window in snapshot mode.

The coordinator seam remains designed but deliberately not implemented: (2) a window cut at a reset checkpoint loses pre-window `request/header`/`request/context` folds because those events are not surface events, so the restore must carry the pre-window folded header snapshot (the plan's hash chain makes it verifiable) or the coordinator back-seeks below the cut; (3) `prepareCore` (session-persistence/coordinator.ts) gains the windowed path over the sqlite `loadStoredFrom` suffix with pair-adjacency validation, falling back to the full load elsewhere; (4) acceptance is a cold open whose `deriveMessages()` is byte-equal to a full-log open plus the equivalence spec staying green.

## Consequences

A windowed fold is only equivalent when the window starts at or after a whole-surface replacement; arbitrary cuts still throw, so no caller can silently resume from a non-boundary. The cold-open full-load cost stays until the coordinator seam lands, and the equivalence spec is the acceptance anchor that seam must keep green.

## Alternatives considered

Rebasing the window to seq 0 at restore was rejected: absolute seqs are durable identifiers (sourceEventSeqs, display history, provenance), and rebasing would fork the identity contract. Compaction checkpoints stay out of v1: compact markers summarize rather than replace, so window equivalence would need the summary payload carried with the window, while reset markers alone already deliver the cold-open win after Track A.
