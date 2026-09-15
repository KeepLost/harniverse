# Agent Note: Session search overhaul — CJK recall, merged scopes, summary extraction, O(1) live fingerprints

Status: implemented

English | [中文](2026-09-15-session-search-cjk-and-merged-scopes.zh.md)


- Date: 2026-09-15
- Scope: `dsh-session-query`, `dsh-session-query-sqlite`, `dsh-tool-session-query`
- Owner direction: retire `session_event_search` in favor of `session_search` with an explicit session range; keep `compaction_history_search` current-session-only; fix CJK recall, rewrite model-facing guidance, and remove the per-search full live observation cost.

## Problem

1. **CJK queries returned nothing.** The production composition bundles `session-query-sqlite`, whose FTS5 `unicode61` tokenizer treats an unspaced CJK run as one whole token; a query like `压缩` only matches when a document contains that exact whole token. Chinese transcripts virtually never separate words with spaces, so content search was effectively unusable for Chinese sessions (verified against `node:sqlite` before implementation). The agent-facing symptom was misattribution: "messages became unsearchable after compaction."
2. **Four overlapping tools confused model selection.** `session_find` / `session_search` / `session_event_search` / `session_inspect` carried implementation vocabulary ("folded current model-message surface", "shadowed and log-only trajectory") with no decision-path guidance.
3. **`compaction/summary` events were invisible to search.** `extractSessionEventText` whitelisted only six event kinds, so summary events contributed no documents even though their content is log-only and otherwise unrecoverable through search.
4. **Every search paid a full observation tax.** `_observeStable` re-observed every live session before each search: `structuredClone` of the entire log, a full `foldSurface` replay, document rebuild, and a sha256 over `JSON.stringify` of the whole log for the fingerprint — on 100k+ event sessions this is seconds per search and serializes behind `_serialized`.

## Decision

### CJK recall (index and query sides)

- `ngramFtsText` (session-query-sqlite `query.ts`) sanitizes then rewrites every CJK/kana/hangul continuum longer than two characters into space-joined overlapping bigrams, applied at all three indexing sites (persisted docs, live docs, titles) and to the normalized query. Two-character runs stay verbatim, so `压缩` matches as a token inside longer bigram sequences.
- `quoteFtsData` now quotes each whitespace-separated term individually and joins with spaces: FTS5 ANDs independent phrases instead of demanding adjacency. Multi-term queries match reordered text; the prior single-phrase quoting made `压缩 问题` demand the two terms adjacent.
- `makeSnippet` strips the inserted bigram joins so excerpts read as original prose; `matchStart` stays approximate by construction (it only anchors the excerpt window).
- `SESSION_QUERY_SQLITE_SCHEMA_VERSION` 9 → 10: index text changed shape, so derived tables rebuild in place.
- Single CJK characters remain unmatchable (bigrams are the index unit); documented as a Known Limitation and left to `filterEvents()` literal scans.

### Tool merge: one scope selector instead of two tools

- `session_event_search` is withdrawn (registration, parameters, presentation, prompt text, tests, tool catalog). No compatibility alias: pre-release contract, per repo policy.
- `session_search` gains the one-session scope by routing on `session_ids`: exactly one id runs the absorbed single-session path (`executeOneSessionContentSearch`) — per-target authorization, caller's-own-session allowed with the range clamped before the active `step/start`, `SESSION_QUERY_TOOL_NO_CURRENT_STEP` preserved — returning every matching event; zero or several ids keep the broad per-session best-match reading, which still omits the caller session.
- No new parameters: the existing `session_ids`, `event_seq_from/to`, `event_time_from/to`, `event_types`, `event_surfaces` cover the merged surface.

### Model-facing rewrite

- `PROMPT_TEXT` and the three descriptions are decision-path guidance: find by title/time → `session_find`; find by wording → `session_search` (CJK sub-words, compacted turns searchable); exactly one id → every event in that session; read one session → `session_inspect` with the messages/history compacted-turn distinction stated; compacted summaries recovered via `compaction_history_search` then `compaction_history_expand`.
- The shared prompt, README prose (en/zh), and generated tool catalogs were updated together; `docs/tool-catalog.md` regenerated, `docs/tool-catalog.zh.md` and the website mirror hand-synced (the translate pipeline is owner-invoked only).

### Summary extraction

- `extractSessionEventText` projects `compaction/summary` events through the same `contentText` used for user messages, so summary blocks become shared search documents. `dsh-session-query` declares `dsh-compaction` as a type-only peer/dev dependency for the declaration-merged event type and references it in tsconfig, following the token-meter precedent.

### O(1) live fingerprints and observation skip

- `liveFingerprint(session)` = `(event count, last seq, surface replace generation)`. The log is append-only and replacements only increment the generation, so this triple identifies content as strongly as the removed sha256-over-log hash while costing three reads.
- `_observeStable` consults the indexed fingerprint first: an unchanged fingerprint with matching persisted state records a lightweight `LiveObservation` and skips cloning, folding, title folding, and document rebuilding; only moved fingerprints produce a full observation that rewrites the index rows. The schema bump guarantees stale sha256 fingerprints never compare equal, so the first post-upgrade search rewrites once and subsequent searches skip.

## Alternatives considered

- **FTS5 `trigram` tokenizer** — verified available in node v24, but two-character CJK queries (the dominant Chinese word length) do not match under trigram's three-character minimum; rejected in favor of bigram folding.
- **External segmenter (jieba-wasm / lindera)** — heavyweight dependency, nondeterministic recall surface (segmentation misses replace token misses); deterministic bigrams chosen instead.
- **Event-level incremental index subscription (full D2)** — larger change with self-healing complexity; the fingerprint skip removes the per-search cost for unchanged sessions at a fraction of the risk. Deferred with owner visibility, not silently.
- **`session_ids: ["current"]` sentinel** — rejected as an API wart; the caller's own session id is a normal explicit target under the merged rule.
- **Pure-LIKE fallback for single CJK characters** — unindexed full scans on the hot path; `filterEvents()` already offers literal scans to the model.

## Consequences

### Model experience

- Chinese (and kana/hangul) content queries now return hits; multi-word queries no longer demand adjacency.
- One fewer tool; guidance reads as a selection path rather than a capability inventory; compacted-turn searchability is stated where the model looks.
- Per-search latency for unchanged live sessions drops from full-log processing to milliseconds; changed sessions still pay one full observation per change, and FTS row rewrites remain proportional to the changed session.
- Token cost: shared prompt section is comparable in length to the previous text; `session_search`'s description grew by one sentence.

## Verification

- New: CJK integration spec (live + persisted, double-character, phrase, absent, AND semantics), extraction spec for `compaction/summary`, single-scope routing through the merged tool (authorization, step clamping, paging cap, cancellation, diagnostics sanitization, exclusivity classification).
- Updated: `quoteFtsData` and unordered-term ranking expectations (AND semantics is the intended contract change), tool catalog generation (en/zh/website), acp/headless system-prompt and tool-schema snapshots re-recorded keyless.
- `pnpm run typecheck`, scoped vitest suites for all three packages, `verify-tool-catalog`, and `doc-sync` green at commit time.
