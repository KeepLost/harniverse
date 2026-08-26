# Agent Note: Committed summary DAG and bounded in-session compaction history

Status: implemented

English | [中文](2026-08-18-summary-dag-compaction-history.zh.md)

## Problem

Summary compaction preserves the raw append-only Session log but removes older messages from the model's current context. The visible checkpoint carries no model-facing path back to exact source messages, and repeated compaction can summarize an earlier checkpoint together with newer messages. A separate transcript database would duplicate canonical data and create replay, persistence, and deletion consistency obligations.

## Decision

Harniverse ships `@deepseek-ai/dsh-compaction-lossless` as the selected compaction Provider in base, standard, code, Cordis, and standalone headless compositions. It inherits `BasicCompactionEngine`, so automatic pressure, overflow recovery, retention, summarization, cancellation, tool pairing, durable event ordering, and surface replacement keep one implementation. Its `auto` default remains `true`, and all inherited policy fields remain configurable.

The package also registers `ctx.compactionHistory`, an in-memory projection rebuilt from each live Session's append-only event log. The projection attaches on `session/created` when that lifecycle edge reaches its realm, and otherwise attaches from the first published event already present in the Session log; this keeps private Agent-preset realms aligned without requiring Host-plane ownership. A `compaction/summary` becomes searchable only after its matching compact checkpoint commits. A leaf node cites raw message seqs; a condensed node cites earlier committed summary nodes and separately retains raw messages introduced in its own replacement. Stable node ids derive from the owning Session id and summary event seq.

`@deepseek-ai/dsh-tool-compaction-history` consumes that service through `compaction_history_search` and `compaction_history_expand`. Search performs case-insensitive all-term matching over committed summary text. Expansion follows parent links and optionally returns raw message sources. Configuration caps result count, DAG depth, and a deterministic token estimate; the expansion tool applies the token cap to its complete rendered result, including metadata.

## Durability and trust

The Session event log remains the only persisted transcript. Resume and HMR rebuild the projection, Session disposal drops it, and orphaned summaries from failed replacements never enter the searchable DAG. The tools derive the caller's Session from the protected tool execution identity, so ids from another live Session cannot cross the service lookup.

Recovered summary and source text is untrusted historical data. The Consumer contributes a stable system-prompt warning and never injects recovered text as instructions. Tool calls return ordinary logged tool results, preserving model-visible reconstruction and leaving an existing request prefix unchanged.

## Relation to recallable compaction

This decision partially overlaps the broader [recallable compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md). The shipped DAG adds automatic recall without changing the proven one-checkpoint surface transaction. It does not implement frozen index stubs, a mutable state checkpoint, concurrent chunk summaries, pagination cursors, or prefix-cache stabilization; that proposal remains active for those distinct mechanisms.

## Alternatives considered

**Copy raw transcripts into a DAG store** was rejected because the Session log already owns exact source bytes, persistence, replay, deletion, and session isolation. The DAG stores only a live derived index.

**Fork the basic compaction transaction** was rejected because it would duplicate failure recovery, locking, range validation, and durable ordering. Inheritance keeps the Provider difference limited to the additional projection service.

**Publish every `compaction/summary` event immediately** was rejected because summary generation precedes replacement commit. A failed transaction would expose a node that never became conversation history.

**Semantic search or a persistent FTS index** was deferred. Current-session logs are bounded and in memory; deterministic term matching keeps recall keyless and replay-independent.

## Consequences

Compacted details remain recoverable from canonical history under explicit count, depth, and output bounds, while automatic compaction behavior stays aligned with the basic Provider. The model pays fixed prompt and schema tokens for the two shipped history tools, plus ordinary tool-result tokens only when it calls them.

The summary directory remains model-generated and can omit the clue needed to trigger recall. Search is live-session-only, and surface replacement still invalidates KV-cache reuse from the first replaced node. The broader frozen-prefix design remains separate rather than being implied by the `lossless` package name.
