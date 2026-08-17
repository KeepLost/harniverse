# Agent Note: Durable tool result retention

Status: implemented

English | [中文](2026-08-16-durable-tool-result-retention.zh.md)

## Problem

Tool output bounds protect model context only when they apply to the complete finalized result. A tool body, a post-execute policy, and definition-owned finalization can each change text, so an earlier cap can be bypassed by later expansion. Shortening inline text without first retaining the complete value also destroys information, while returning an unbounded value when retention fails defeats the bound. Retrying a side-effecting tool merely because result retention failed can repeat an operation that already completed.

Recovery must survive Session and process lifecycles without exposing backend paths as a portable protocol. File readers and search tools also need producer-side bounds: a retained artifact is not useful if reading one enormous line or capturing one enormous grep record recreates the same memory and context problem. Compaction must reduce older history without routinely rewriting recent tool results, invalidating an earlier KV-cache prefix, or losing the provenance needed to price and replay each replacement.

## Decision

### Finalized-result authority

The shipped [`dsh-tool-result-artifacts` Consumer](2026-08-17-plugin-owned-result-artifacts.md) is the authoritative retention point on `tools/finalize-result`, after post-execute processing and definition-owned content finalization. Its `maxResultTextChars` defaults to the 50,000 Unicode code-point platform ceiling across recursively model-visible text blocks and may lower that ceiling to no less than 120, which fits the complete retention-failure safety warning. Code points, rather than UTF-16 code units or UTF-8 bytes, keep the inline rule stable for supplementary Unicode characters.

When finalized text exceeds the limit, `dsh-tool-result-artifacts` first saves the complete concatenated formatted text through `SpillStore.saveText`. Only after the backend confirms the exact UTF-8 byte count does the Consumer replace inline text with one bounded head/tail view containing an `artifact_read` locator. The committed `tool/result` carries the same bounded content plus a structured `{ kind: 'full-result', locator, bytes }` artifact reference, so replay, UI projection, and the next model request agree on both the visible result and where its complete text resides.

Non-text content blocks stay in their original positions while the aggregate text budget is distributed across text blocks. `additionalContexts` remains a separate model-visible channel because it is not tool-result text and has its own ownership and logging rules.

If the execution has no owning Session, saving rejects, or the backend reports a byte count inconsistent with the saved text, `dsh-tool-result-artifacts` returns `TOOL_RESULT_RETENTION_FAILED` with a warning that fits the same text ceiling. The warning says the operation may have completed and forbids blind retry. It does not return the oversized value, claim an artifact exists, or convert uncertainty about result retention into permission to repeat side effects.

### Durable artifact retrieval

`SpillStore` owns both `saveText` and bounded `readText`. A locator and continuation cursor are opaque outside the backend; consumers pass them through unchanged. The local backend stores artifacts under the durable harness home, returns versioned non-path locators, opens validated regular files without following symlinks, and uses a backend-owned UTF-8 byte cursor. A cursor may continue within one logical line, but it must fall on a UTF-8 boundary.

The model-facing `artifact_read` tool requests one backend page and renders its text verbatim, adding an explicit locator-and-cursor continuation only when unread text remains. Its default page is 12,000 code points and its maximum is 50,000. Keeping cursor interpretation in `SpillStore.readText` lets local, remote, and database backends choose their own addressing and pagination without teaching the tool about host paths.

### Bounded readers and search

The filesystem `read` tool always uses `streamText`; file size and backend size metadata do not select a whole-file path. Its returned cursor combines a one-based line offset with a zero-based intra-line UTF-8 byte offset, so a single huge line can be consumed without loading or silently skipping its remainder. The string-replacement editor reuses the same streaming window renderer for `view`, while mutation commands retain a separate whole-input size bound because replacement and insertion require the complete source value.

`grep` asks ripgrep to apply the per-line preview limit before stdout capture, uses unambiguous NUL-separated fields, and retains the aggregate raw-output limit. The renderer keeps bounded match and metadata views. These producer-side constraints complement final result retention: the result-artifact Consumer can durably preserve only data that reaches final rendering.

### Compaction, accounting, and settlement

Shipped compositions disable the legacy `dsh-spill-policy` final-result transformer and the retroactive `dsh-compaction-tool-result-pruner` by default. The first is redundant with the shipped result-artifact Consumer and has best-effort fallback semantics; the second rewrites already committed tool-result history and can invalidate KV-cache reuse earlier than necessary. Deployments may explicitly enable the pruner when lower summarizer input cost or overflow repair outweighs that rewrite, but disabling it later does not undo durable prune replacements.

Default compaction therefore summarizes the selected original surface directly. Compaction invariants require each `compaction/summary` or `compaction/prune` metering event to be followed immediately by its replacement, require the replacement range and ordered `sourceEventSeqs` to match the metering event exactly, and allow a successful `compaction/end` only after the summary replacement commits. These adjacency and provenance rules make replay and shadow-token subtraction deterministic rather than relying on nearby-event heuristics.

Token usage is cumulative across ordinary model steps and auxiliary summarizer calls. A `compaction/summary` usage sample adds to totals independently and never replaces the current step sample. `compaction.settled` is privacy-minimal: it projects only from durable `compaction/end` and carries correlation and outcome metadata (`compactionId`, nullable turn, ending sequence, success, and optional source command id). It emits neither summary text nor error detail, and there is no compaction-start notification.

### Limitations

There is no reachability garbage collection for artifacts. Closing a Session does not delete its artifacts, because durable log references can remain useful after close and forked Sessions can retain inherited locators. Retention-period cleanup and deletion coordination remain separate work.

Legacy oversized log events are not rewritten, and this decision does not manufacture artifact references for results committed before authoritative finalization. Non-text blocks and `additionalContexts` are outside the 50,000-code-point text cap. Data a producer discarded before final rendering, including provider-truncated bodies or executor output represented only by an earlier local summary, cannot be recovered by `dsh-tool-result-artifacts` or `artifact_read`.

`artifact_read` provides sequential text paging only. It has no reachability discovery, search, random access, or metadata protocol; a caller continues with the cursor supplied by the owning backend.

## Verification and rollout

Result-artifact package tests and agent-loop integration tests pin exact-limit passthrough, post-finalization expansion, Unicode code-point counting, complete-save-before-preview ordering, byte-count verification, non-text preservation, structured durable references, and bounded `TOOL_RESULT_RETENTION_FAILED` behavior. Spill seam and local-backend tests pin opaque locators, persistence across service disposal, regular-file and traversal checks, huge single-line paging, UTF-8 cursor boundaries, and exact continuation. Loader composition tests prove combined retention and `artifact_read` registration, schema, default page size, disposal, and real backend retrieval.

Filesystem and editor tests pin always-streaming windows, intra-line continuation, bounded mutation input, and shared view rendering. Search tests pin producer-bounded line previews, field parsing, raw-output overflow, and bounded presentation metadata. Compaction invariant tests reject missing, non-adjacent, range-mismatched, and provenance-mismatched replacements; token-meter tests prove summarizer usage accumulates; notification tests prove seeded and live settlements expose no summary or error payload.

The base bundle loads the durable local `SpillStore` and `dsh-tool-result-artifacts`, whose one fiber owns `artifact_read` and the 50,000-code-point ceiling. Presets keep direct summary compaction and leave spill-policy and the pruner disabled. Deployments omit retention and retrieval together rather than leaving a half-composed marker; deployments that opt into pruning accept its durable history rewrite and KV-cache cost. No log migration or artifact cleanup runs during rollout.

## Alternatives considered

**Keep `dsh-spill-policy` as the default final-result owner.** Rejected because a post-execute listener runs before definition-owned finalization can finish expanding content, is optional in composition, and returns the original oversized result when retention fails. The shipped `tools/finalize-result` Consumer sees the authoritative value and can enforce one failure meaning for every dispatch path.

**Shorten first and retain asynchronously or best-effort.** Rejected because a crash or storage failure can leave a durable preview whose omitted text never existed in the artifact plane. Retention confirmation precedes shortening and commit.

**Return the successful oversized result when artifact retention fails.** Rejected because it abandons the platform context ceiling exactly when storage is unhealthy. Returning a generic retryable failure was also rejected: the tool operation may already have committed side effects, so the stable error explicitly warns against blind retry.

**Expose local artifact paths and reuse ordinary `read` and `grep`.** Rejected because paths are not portable across remote or database backends and leak storage layout into durable protocol. `artifact_read` keeps locators and cursors backend-owned. Ordinary file `read` and `grep` remain workspace-oriented tools with their own observation and presentation semantics.

**Enable retroactive tool-result pruning in every composition.** Rejected as the default because authoritative finalization already bounds new results and preserves their complete text. Routine pruning mutates committed history, can break an earlier reusable KV-cache prefix, and complicates provenance. It remains an explicit overflow and summarizer-cost trade-off.

**Exclude auxiliary summarizer usage or publish summary details in notifications.** Rejected because excluding usage understates actual model consumption, while publishing summary text or failure detail crosses the notification service's privacy-minimal metadata purpose. Durable compaction events retain the detailed local record; cumulative accounting and settlement notification expose only what their consumers need.

## Consequences

Every newly finalized oversized text result is bounded and either recoverable through a durable structured reference or represented by a bounded failure that prevents unsafe automatic retry. Retrieval is portable across storage backends, huge lines remain pageable, and producer-side search bounds prevent a finalizer from being the first resource defense.

The design spends durable storage and one synchronous save on each oversized finalized result, retains artifacts beyond Session close, and requires a spill backend wherever large results must succeed. Summary-only compaction preserves more recent history and KV-cache reuse but can send more text to the summarizer than an opted-in pruner. Stronger replacement invariants reject malformed legacy or extension-produced compaction sequences instead of inferring intent, and cumulative usage makes reported consumption larger but accurate.

This note partially supersedes the default-policy and retrieval choices in the [tool output spill policy](2026-07-08-tool-output-spill-files.md) while retaining its separation between storage, resource acquisition limits, and presentation retention. The [after-call compaction decision](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) continues to own pressure and overflow recovery; this decision narrows the shipped default to direct summarization and strengthens replacement evidence.
