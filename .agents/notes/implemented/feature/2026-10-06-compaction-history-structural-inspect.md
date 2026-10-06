# Agent Note: Structural compaction-history inspection — one tool, four views

Status: implemented

[中文](2026-10-06-compaction-history-structural-inspect.zh.md) | English

## Problem

The compaction-history Consumer shipped two text-centric tools: `compaction_history_search` (term match over summary text) and `compaction_history_expand` (bounded ancestry of one summary). Three gaps surfaced in review:

1. The pair overlapped with session-query for raw recall (`session_inspect` history returns compacted originals; `session_search` indexes compacted turns), so its catalog cost bought little unique surface.
2. Neither tool exposed the DAG *as structure*: how many rounds committed, which span each replaced, where a given message sits — the data (`kind`, `depth`, `shadowedRange`, `shadowedTokenCount`, parent links) already existed on every `CompactionHistoryNode`, and the service's `stats()` verb had no caller at all.
3. Recovering a specific original message required composing session-query's seq-range search with knowledge of the summary spans — a multi-tool dance the model had to discover from prose guidance.

## Alternatives considered

- Keep the two tools and only add structural views: rejected — the text pair duplicated session-query recall while the unique structural data stayed hidden, and a third tool would grow the catalog further.
- Make raw messages first-class searchable vertices with a global in-tool FTS: rejected — duplicates the session-query capability seam with weaker matching semantics and an unbounded scan obligation.

## Decision

- **Merge to one tool: `compaction_history_inspect`** with a required `view` (`overview` / `search` / `node` / `locate`), following the `session_inspect` view idiom.
  - `overview` — stats plus one structural row per committed round: id, kind, depth, replaced span and its token count, summary size, parent/source counts, provider route, time, deepest-parent lineage chain.
  - `search` — term match over summary text **and/or the source messages committed nodes cite** (`scope` `summaries`/`sources`/`both`), restrictable to one exact `depth`; every hit carries DAG coordinates (summary hits: replaced span + lineage; source hits: covering node).
  - `node` — the former expansion, bounded by depth and deterministic token estimate, with the untrusted-history framing preserved verbatim.
  - `locate` — one `event_seq` resolved to `live`, `pending` (summary committed, checkpoint not settled), or the shadowing round with relation `source` / `checkpoint` / `other`.
- **Sources are searchable inside this tool, bounded by the projection**: the scan walks committed nodes' `sourceEventSeqs` over the in-memory session log (milliseconds at realistic shadowed volumes); it is term matching, not FTS, and workspace-wide full-text search stays owned by `dsh-session-query`. Each original message is shadowed exactly once, so per-layer source sets are disjoint and hits need no dedup.
- **Lineage renders one deterministic deepest-parent chain**; every parent remains countable in `overview` and recoverable through `node`, which keeps a multi-parent condensed round honest without printing a tree.
- Service seam grows to own the reads the tool needs: `list()`, reshaped `search(options)` (scope/depth/limit), `locate()`; `expand()` and `stats()` are unchanged. The tool layer computes no graph structure of its own.

## Consequences

- The model-facing catalog shrinks by one tool; every consumer of the old names (preset capability map, session-query guidance, exact-catalog e2e lists, generated catalogs) was updated in the same change, so no stale reference remains.
- Source-message text becomes reachable through this tool under term matching; the untrusted-history framing covers it, and workspace FTS stays single-owned by `dsh-session-query`.

## Verification

- `packages/compaction/compaction-lossless/tests/summary-dag.spec.ts` — structural descriptors, source-scope search with depth restriction and the shared cap, locate across live/pending/source/checkpoint/other and out-of-range rejection.
- `packages/compaction/tool-compaction-history/tests/` — four views through the real tool registry (including per-view argument validation and the schema-level view enum), plus the Loader REAL-composition boot and dispose assertion.
- Cross-references updated: agent-preset capability map, session-query prompt section, exact-catalog e2e lists (web shipped composition, CLI agent presets, minimal preset snapshot), regenerated `docs/tool-catalog.md`.
