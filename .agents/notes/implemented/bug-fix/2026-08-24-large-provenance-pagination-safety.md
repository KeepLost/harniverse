# Agent Note: Large-provenance pagination safety

Status: implemented

English | [中文](2026-08-24-large-provenance-pagination-safety.zh.md)

## Problem

History pagination keeps an append-origin message together with the earlier events named by its `sourceEventSeqs`. The shared materialized paginator, the reverse JSONL reader, and the SQLite candidate reader each found that group boundary with `Math.min(event.seq, ...sourceEventSeqs)`. Spreading the array turns every provenance entry into a positional argument, so a sufficiently large list can exceed the JavaScript engine's call-argument limit and throw instead of returning a page.

Large provenance is legitimate: a finalized Assistant message may cite every streamed chunk that produced it, and a replacement may cite a large shadowed range. The page-size quota bounds append-origin messages, not the number of source references carried by one message, so the ordinary quota cannot prevent this failure.

## Decision

All three pagination paths compute the minimum iteratively. Each starts the cut at `event.seq`, scans `sourceEventSeqs` when present, and replaces the cut only when it sees a smaller seq. The shared `paginateSessionHistory` implementation covers materialized and inherited persistence readers; JSONL applies the same calculation while scanning reverse records; SQLite applies it after decoding the oldest candidate row.

The calculation preserves the existing grouping result, runs in linear time over the provenance list, and uses constant additional space without converting the list into function arguments. Backend-native readers remain separate because JSONL bounds reverse decoding and SQLite bounds candidate queries according to the [compaction-first history decision](../architecture/2026-08-22-compaction-first-session-history.md).

## Regression design

The regression uses 131,072 `sourceEventSeqs` entries while persisting only the minimal turn-start, source-chunk, and finalized-message events needed to exercise a native page read. Every provenance entry names the same persisted source seq. Pagination only consumes the minimum and does not own Session provenance uniqueness validation, so repeating that seq reaches the argument-cardinality failure without constructing 131,072 unrelated persisted events.

The shared paginator test pins the materialized path. The reusable persistence contract enables the compact native case for uncompressed JSONL, Zstandard JSONL, and SQLite, and verifies that the page includes the source and finalized message, preserves the complete provenance list, and reports earlier history through `hasMore`.

## Scope

This decision changes only how persistence pagination computes a message group's earliest seq. It does not change history request or response schemas, durable JSONL or SQLite formats, page quotas, checkpoint preference, authorization, owner sealing, or standing Profile scope. In particular, no authentication or Profile behavior changes.

## Alternatives considered

**Cap or truncate `sourceEventSeqs`.** Rejected because provenance is durable event evidence used by replay and validation. A pagination implementation limit must not weaken or rewrite that evidence.

**Call `Math.min` on fixed-size chunks.** Rejected because chunk size would be an arbitrary dependency on engine argument limits and would retain spread calls where a direct scan expresses the operation without that limit.

**Route JSONL and SQLite through the shared materialized paginator.** Rejected because materializing the full eligible history would discard each backend's bounded access pattern and regress the compaction-first history guarantees.

**Persist one source event per regression entry.** Rejected because the failure depends on provenance-list cardinality, not log cardinality. A 131,072-event fixture would add storage and decode work unrelated to the defect and make the focused contract unnecessarily expensive.

## Consequences

A history page no longer fails merely because one append-origin message carries more provenance entries than the engine accepts as function arguments. Page boundaries and returned events remain unchanged for existing inputs, and provenance arrays remain byte-for-byte data rather than being normalized or truncated.

Each native backend retains a small copy of the iterative minimum calculation. That duplication preserves bounded backend access, while the shared contract makes divergence observable across JSONL, Zstandard JSONL, and SQLite. The scan remains proportional to the provenance list, which pagination already had to inspect to find the same boundary; this change removes the call-argument hazard rather than imposing a new provenance-size policy.
