# Agent Note: The Current context strip shows the post-compaction window, not the ledger

Status: implemented

English | [中文](2026-10-01-trajectory-current-context-compaction-window.zh.md)

## Problem

The `Current context` strip under the Trajectory ledger was derived from `eventNodes`, but the Trajectory snapshot builder routed every compaction contribution into `requests` only — no `kind: 'compaction'` node ever reached `eventNodes` — so the absorption branch in `deriveRequestContext` was dead code in the assembled UI. After a landed compaction the strip therefore kept listing every surface message since the session start, exactly mirroring the ledger it sits under, while the model's actual context was the checkpoint summary plus the tail. The strip answered nothing the ledger had not already answered.

## Decision

Landed compactions ride the assembled nodes at the checkpoint's own position.

- The Trajectory compaction Definition builds a `CompactionSummaryNode` marker (summary text, `summaryEventSeq`, `shadowedItemCount` from `shadowedSeqs`, `shadowedTokenCount`) once the replacement checkpoint landed, and carries it on its contribution; the snapshot builder pushes it into `eventNodes` and `eventLocations` while the request keeps owning the visible ledger cell (the layout's existing compaction-node skip arm becomes live).
- `deriveRequestContext` now truncates everything a landed marker shadows — earlier summaries included, since a later round re-summarizes them — leaving the latest summary plus the surface items after its checkpoint. The replacement checkpoint (a plugin-sourced `user/message`, hence a `context` node) shares the marker's seq; the marker represents it and the duplicate surface block is skipped.
- Model-visible semantics only: no runtime, session-log, or event-format change. The Chat target's own marker is untouched.

## Alternatives considered

- **Derive the window from `requests` alone** — rejected: a compaction request carries no shadowed counts and no checkpoint linkage by itself; the checkpoint-matched Definition state is where both already live.

## Consequences

After any landed compaction the strip drops to the latest summary plus the post-checkpoint tail, in both fresh sessions and replays; sessions without compaction are unchanged. Repeated compactions collapse to the newest summary. Clicking a summary block still navigates to the owning ledger record via the checkpoint seq.
