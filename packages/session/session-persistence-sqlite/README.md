# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

A SQLite durable session-persistence backend — a second `SessionPersistence` provider ([session persistence](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)) satisfying the same contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

`locate(meta)` returns `undefined`: all sessions share one database, so there is no honest independent per-session transcript path.

`readHistoryPage()` uses indexed `seq` order to find the latest append-origin message candidates, then reads one contiguous logical event range. `readRawEventPage()` instead bounds the raw event count, selects only the newest physical rows needed for that quota, and decodes the bounded logical span. Neither path reconstructs the complete session log for a cold backward page, even when the requested range starts inside a packed row.

## Storage model

Schema 17 stores ordinary `SessionEvent` values as scalar rows and compatible runs of at least three consecutive `assistant/chunk` text, reasoning, or tool-call deltas as packed physical rows. Packing preserves every logical event, timestamp, sequence number, chunk boundary, and optional surface field. One row represents at most 1,024 logical events and 1 MiB of uncompressed UTF-8 `data`; payloads of at least 4 KiB use Zstandard level 3 only when the compressed frame is smaller. Scalar `source_event_seqs` values use lossless Varint/ZigZag delta encoding, including a distinct representation for an empty list. The full physical rules and rationale live in the [SQLite chunk-row Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-sqlite-physical-chunk-row-compression.md).

Out-of-log metadata (`SessionHeader`), a per-materialization incarnation id, and a monotonic per-log revision live in a `sessions` row; `createdAt` is a non-negative safe integer stored in a strict `INTEGER` column. A singleton state row carries the immutable store id. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`list` reports exactly the sessions that have a row).

The repository's Node range supports unflagged `node:sqlite`. The database disables trusted schemas and memory-mapped I/O, enables foreign keys, pins `synchronous=FULL`, and uses the configured journal mode (`wal` by default; use a rollback mode where WAL shared-memory files are unsuitable). `PRAGMA application_id` identifies the canonical persistence database, and `PRAGMA user_version` stores its layout version. A fresh database must have no application identity or user-defined schema objects; initialization creates every table and stamps both pragmas in one transaction. Non-pristine unversioned databases, foreign application identities, and every non-current version reject before journal-mode mutation because this unreleased format has no migrations.

On filesystems with POSIX modes, the backend requests mode `0700` for missing directories and exclusively creates a missing database with mode `0600` before SQLite opens it; the process umask may further restrict both. Existing database files must be regular, owner-only, owned by the effective user, and reached through a safe parent directory rather than a symlink. New WAL, shared-memory, and persistent rollback-journal sidecars receive the database's resulting owner-only mode. These checks prevent incidental exposure or path substitution, but they do not encrypt the database.

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN IMMEDIATE` around the batch: it verifies schema ownership, derives the next logical sequence from the decoded physical tail, materializes the `sessions` row if needed, and inserts batch-local scalar or packed rows. A stale cursor or mid-batch failure rolls back entirely, so the stored log and in-memory cursor stay consistent. Normal append never rewrites an earlier packed row.
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `list()` (which reports exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` implements the shared [crash-recovery contract](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md): preserve the valid interrupted turn, append its synthetic closing events in one transaction, and remove only a torn physical tail. Committed parse errors or logical sequence gaps make the session unloadable. Repair revalidates its physical marker under the write lock, so stale recovery cannot delete a newer valid suffix.
- **Logical suffixes over physical rows.** `readFrom()`, `readHistoryPage()`, and `readRawEventPage()` inspect the bounded packed predecessor that may contain the requested sequence, decode it as one logical span, and return only members inside the requested range.
- **Non-mutating inspection.** `inspect()` returns an immutable balanced logical view and may synthesize recovery closers in memory, without deleting a torn tail row, appending recovery rows, or changing the lightweight revision.
- **Cold deletion.** `delete(id)` removes the `sessions` row in one statement; the foreign key cascades its event rows in the same transaction. The shared coordinator rejects live or exclusively prepared identities and serializes deletion against same-id operations. Recreating the same id receives a new incarnation, so its lightweight revision cannot collide with the deleted lifecycle.
- **Lightweight revisions.** `listSnapshots(signal?)` combines the immutable store and database-file identity, a per-materialization incarnation id, and a per-session counter incremented in each mutating transaction. A full-prefix read captures that revision and its event rows in one read transaction, while `readStoredRevision()` queries only the session row to validate retained preparations. This keeps unchanged observations stable without parsing event rows and distinguishes independent stores and recreated same-id logs. It checks cancellation before and after shared readiness and the synchronous metadata query; the query itself is non-preemptible.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // positive integer; default 5000
  preparedSessionCacheSize?: number   // positive integer; default 5
  writeBatchMaxDelayMs?: number   // positive integer; default 200; maximum 2_147_483_647
}
```

## Write path

Like the JSONL backend, the plugin copies each frozen `session/event` into one controller per live session. The first pending event starts the configured fixed batching window, and later events join without resetting it. Expiry starts one transaction; events admitted during that write form a separately bounded follow-up batch. `session/flush` cancels the wait and drains current and pending batches. The controller persists a fork's seed once, keeps a write cursor so resume never re-appends stored events, and seeds live sessions on apply because HMR does not replay `session/created`. Dispose drains every retained controller before closing the database. Packing is confined to each durable batch, so sparse or explicitly flushed deltas may remain scalar.

## Model Experience

### Resumed conversation history

#### What the model sees

SQLite storage contributes no live prompt or schema. Loading restores the same surface history as JSONL and preserves prior headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Row metadata and raw chunks are not messages.

#### Token effect

Zero live-request tokens. Resume restores retained history and pays the current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

SQLite storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **`DatabaseSync` is synchronous** — every append transaction blocks the event loop for its duration; acceptable for local stores, a throughput ceiling for busy multi-session servers.
- **Write contention blocks synchronously** — each connection waits up to `busyTimeoutMs` for a competing lock, and `DatabaseSync` blocks its JavaScript thread during that wait.
- **Only a pristine new database or the current owned `SCHEMA_VERSION` opens** — unversioned schema objects, foreign application identities, and every other schema version are rejected rather than migrated (unreleased software; no persisted user data to preserve).
- **TODO:** this backend talks to `node:sqlite` directly. If a cordis database service (`cordis/db` / a `@cordisjs` SQL driver plugin) is adopted, route through that instead of holding a raw `DatabaseSync` here — the contract surface (`SessionPersistence`) would not change, only the storage driver.
