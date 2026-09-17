# Agent Note: Session search snippets read from source prose, and relevance counts come from the inverted index

Status: implemented

English | [中文](2026-09-17-session-search-snippet-fidelity.zh.md)

- Date: 2026-09-17
- Scope: `@deepseek-ai/dsh-session-query-sqlite` (schema version 11, ranking, snippet presentation)
- PR: <!-- SHA backfilled after merge -->

## Problem

`session_search` returned corrupted CJK snippets. Bigram folding gives CJK/kana/hangul sub-words their recall under `unicode61`, and the folded text was written into the one indexed `text` column that `highlight()` later read back to build the excerpt. Presentation tried to undo the folding by deleting the inserted join whitespace, which is not an inverse of an overlapping-bigram expansion: `中文字符` was stored as `中文 文字 字符` and shown as `中文文字字符`, doubling every interior character. The same deletion could not distinguish an inserted join from an author's space, so `你好 世界` was shown as `你好世界`. Kana and hangul shared both defects; ASCII was unaffected, which is why the tests missed it. The corruption was model-visible: the snippet is the only content a cross-session hit carries.

Recovering the prose from the folded text is impossible in principle. A continuum of one or two characters folds to itself, so after folding an author's space and a bigram join are the same byte in the same position.

Ranking had a separate, independent cost. `highlight()` rebuilt every candidate document as a marked string and a SQL `replace` scanned that string again to count markers, so each search cost time proportional to the total size of all matching documents rather than to the page it returned. CJK documents paid that on the folded text, roughly three times their prose.

## Decision

- **Each document row stores its source prose beside the folded text.** `persisted_docs` and `temp.live_docs` gain `raw_text UNINDEXED`, mirroring the `raw_title` companion `persisted_titles` already had. `raw_text` stays NULL when folding changed nothing, so corpora without folded continua store no second copy, and readers project `COALESCE(raw_text, text)`. `codepoint_length` now measures the prose, so the length tie-break compares documents rather than encodings — the same measure the browser fixture already used.
- **Relevance counts indexed term instances from each table's `fts5vocab(..., 'instance')` companion.** Ranking reads the inverted index instead of the documents: no candidate is fetched or re-scanned to score it. The counts stay source-comparable across the persistent and TEMP tables because both are raw instance counts of the same terms — the property `bm25()` cannot provide, since its IDF and average document length are per-table statistics and the live table usually holds one or two sessions.
- **Ranking terms come from SQLite, not from a JavaScript reimplementation of `unicode61`.** A TEMP FTS5 table with the same tokenizer configuration tokenizes the folded query, and its `fts5vocab(..., 'row')` companion yields the exact index terms, including case folding and diacritic removal (`CAFÉ` → `cafe`, `Straße` → `straße`). The count join is a LEFT JOIN: a document no indexed term reaches ranks last instead of vanishing.
- **Query normalization no longer bakes in the index encoding.** `normalizeQuery` returns the caller's whitespace-normalized text and folding moves to the two MATCH-building sites, so the snippet anchor can address prose and the request identity stays a deterministic function of the caller query.
- **The excerpt window is placed by literal folded-term search in the prose.** Every folded term is a literal substring of the prose it came from (a bigram spans two adjacent characters of its continuum), compared with lowercasing and diacritic stripping guarded to one code point per source character so folded positions keep addressing the source. Any further `unicode61` equivalence anchors at the document start, which the previous implementation already documented as approximate.

## Alternatives considered

- **`trigram` tokenizer** (keeps the original text, so `highlight()` would be correct by construction): rejected on measurement — two-character queries return nothing (`压缩` → 0 rows, `你好` → 0 rows), and two-character words are the bulk of Chinese queries.
- **A custom FTS5 tokenizer** carrying the folding inside the tokenizer, the structurally cleanest option: not available. `node:sqlite`'s `DatabaseSync` exposes no `fts5_api` registration surface.
- **`bm25()` ranking**, the fastest measured option: rejected because its scores are not comparable across the two tables, which the package README states as a contract.
- **Contentless or external-content FTS tables** to avoid storing the folded text: rejected. Contentless tables discard UNINDEXED columns, so the metadata columns and the per-session `DELETE` would move to side tables; external content makes `highlight()` re-tokenize prose whose offsets no longer match the folded index.
- **Reversing the folding at presentation time**: impossible, as above.

## Consequences

- Measured on a 1200-document all-CJK corpus (600 characters each, every document matching), same tables and data: 516 ms → 43 ms for a two-term query and 690 ms → 91 ms for a five-token phrase, with the returned payload dropping to a third of its size because the folded text no longer leaves SQLite. A rare-term query stays sub-millisecond. Storage grew 6.08 MiB → 7.86 MiB (about 29%) on that all-CJK corpus and is unchanged for corpora with no folded continua.
- Snippet-shaped body text is carried through the ranking CTEs rather than joined back after the limit, which measured 43 ms against 33 ms for the post-limit join. The simpler shape keeps one projection site for both query scopes and keeps row-to-hit mapping free of database reads; the remaining difference is available if a larger corpus ever needs it.
- Relevance counts term instances where the previous formula counted merged highlight spans. Both are raw comparable counts and the observed order was identical on every shape exercised, including a multi-token phrase, but a document repeating a term inside one matched span can now rank slightly higher.
- Schema version 11 rebuilds every derived index in place on first open. The `fts5vocab` companion appears in `sqlite_master`, so it joins the recognized derived-table set; the reset drops tables in name order, which reaches the FTS table before its vocab companion (the reverse order is rejected by SQLite).

## Testing

- `packages/session-query` at 322 tests (318 before), per-file 100% on the changed sources.
- The defect is pinned end to end through the real assembly: `tool-session-query/tests/sqlite-integration.spec.ts` asserts the presented `Snippet:` line equals the source prose verbatim, mixed CJK and spaces included. A unit test covers Chinese, kana, hangul, author spaces, and mixed scripts; further tests cover window anchoring, term order, case and diacritic folding, unmatched terms, combining marks, and characters whose lowercase expands.
- The pre-existing source-comparable ranking test and the snippet-bound test passed unchanged, which is the evidence that the ranking contract held.
