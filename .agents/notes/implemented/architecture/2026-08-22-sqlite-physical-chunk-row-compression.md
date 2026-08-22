# Agent Note: SQLite physical chunk-row compression

Status: implemented

English | [中文](2026-08-22-sqlite-physical-chunk-row-compression.zh.md)

## Problem

The scalar [`session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.md) layout stores one physical row for every logical `SessionEvent`. Streaming providers emit token-sized `assistant/chunk` events with repeated envelope and block identity fields. Transaction batching reduces commits but not those rows or repeated JSON fields, while coalescing logical events would change observable sequence numbers, timestamps, chunk boundaries, provenance, replay, and partial output.

A physical row that represents several logical events affects append contiguity, suffix and history-page seeks, corruption classification, crash repair, and stale-writer handling. Its decoding rules must be fixed by the SQLite schema version rather than runtime plugin composition.

## Decision

`@deepseek-ai/dsh-session-persistence-sqlite` uses schema 17. SQLite remains an opt-in `SessionPersistence` provider through `PersistenceCoordinator`; shipped default compositions continue to select JSONL. Packing changes only the physical database representation and reconstructs the exact logical event stream at every provider API.

Scalar rows represent one logical event. Packed rows use the storage tags `text-chunks`, `reasoning-chunks`, and `tool-call-chunks`, with SQL `seq` and `time` taken from the first logical member. Packing requires at least three consecutive compatible deltas from one append batch and exact allowed fields, turn/step/index identity, sequence continuity, and safe timestamp deltas. A packed row represents at most 1,024 events and 1 MiB of uncompressed UTF-8 payload; incompatible or shorter runs remain scalar.

The `data` column accepts `TEXT` and `BLOB`. Serialized payloads below 4 KiB remain text. At or above that threshold, the writer uses Zstandard level 3 and retains the frame only when it is smaller. `source_event_seqs` stores the first sequence as an unsigned varint and subsequent signed differences as ZigZag varints, preserving arbitrary order and distinguishing an empty list from absent provenance.

### Append, reads, and repair

Each append acquires `BEGIN IMMEDIATE`, verifies schema ownership, derives the next logical sequence from the decoded physical tail, and rejects a stale writer before mutation. Packing is batch-local: normal append inserts new rows but never rewrites an earlier packed tail. Event rows, lazy session materialization, and one revision increment commit or roll back together.

Full reads decode each physical row as one all-or-nothing logical span and validate logical continuity. `readFrom()` and `readHistoryPage()` inspect the bounded predecessor that may contain the requested sequence, decode it, and filter reconstructed members to the requested range. A malformed row or gap before a committed `turn/end` is corruption. A malformed uncommitted final row becomes a repair marker at its physical base sequence; repair revalidates that marker under the write lock before deleting the physical tail and appending scalar synthetic closers, so stale repair cannot remove a newer valid suffix.

### Schema ownership

A pristine database initializes with application identity and schema version 17. Older schemas, foreign application identities, non-pristine unversioned databases, incompatible schema objects, symlinks, and unsafe ownership or modes are refused; the pre-release provider supplies no migration. Connections disable trusted schemas and memory-mapped I/O, use the selected journal mode, and pin `synchronous=FULL` so a resolved append retains its durability meaning across SQLite builds.

## Alternatives considered

**Coalesce logical chunk events.** Rejected because it changes replay, partial output, sequence references, and live delivery. Physical packing obtains row reduction while restoring the authoritative log exactly.

**Merge a new batch into the prior packed row.** Rejected because it rewrites committed data and can hide repeated delete-and-insert churn behind a stable retained row count. Batch-local packing bounds mutations to newly durable events.

**Run a periodic compactor.** Rejected because it introduces another writer lifecycle, races append and repair, and changes physical state and revisions without a logical append.

**Configure codecs through plugins.** Rejected because a schema-versioned database must remain readable independently of the active Cordis topology. The durable codec rules are package-owned constants.

**Migrate older schemas in place.** Rejected under the pre-release compatibility policy. Rebuilding strict tables turns activation into an unbounded historical rewrite and temporarily duplicates storage.

## Consequences

Compatible streamed batches occupy fewer physical rows while preserving every logical persistence, replay, revision, pagination, and crash-recovery behavior. Packing ratio depends on append batch boundaries; explicitly flushed or sparse events may stay scalar. SQLite and Zstandard work remains synchronous, so lock waits and large row encoding or decoding block the calling JavaScript thread within the configured bounds.

External SQL consumers cannot assume every `events.type` is a logical `SessionEventMap` member or every payload is text. They must use the provider decoder. Older pre-release SQLite files require an explicit fresh database rather than an automatic migration.

Focused verification covers codec limits and round trips, text/reasoning/tool-call eligibility, Zstandard and provenance encoding, physical row reduction and immutability, packed-range suffix and backward-page reads, committed corruption, malformed-tail recovery, and stale repair.
