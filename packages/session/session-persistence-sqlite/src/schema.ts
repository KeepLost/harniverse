/**
 * Schema + load-time helpers for the SQLite session-persistence backend: the
 * DDL (a store-identity row, `sessions` metadata, and scalar or packed physical
 * `events` rows), the database open/configure step, and the last-`turn/end`
 * cut that gives the SQLite backend the SAME crash-tail-on-load semantics as
 * the JSONL backend.
 *
 * @module dsh-session-persistence-sqlite/schema
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { decodeScalarRow, scanRows as scanPhysicalRows } from './compression.ts'

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `sessions` row).
 */
export const SCHEMA_VERSION = 17

/** SQLite application id protecting unrelated databases from persistence writes. */
export const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 0x44534850

/**
 * A row of the `sessions` table — the out-of-log metadata ({@link SessionHeader}).
 * The row's EXISTENCE is the materialization signal: it is written only by the
 * first `append` (lazy materialization), so a created-but-never-appended
 * session has no row and is absent from `list`, mirroring the JSONL
 * backend's "no file until first append".
 */
export interface SessionRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  origin: 'subagent' | null
  /** Stable identity assigned when this log is materialized. */
  incarnation: string
  /** Monotonic log-change token incremented in each mutating transaction. */
  revision: number
  delegation_depth: number | null
  agent_preset: string | null
}

/** An `events` physical row; `data` is JSON text or a Zstandard frame. */
export interface EventRow {
  seq: number
  type: string
  time: number
  data: string | Uint8Array
  /** Varint/ZigZag-encoded sourceEventSeqs, or null. */
  source_event_seqs: Uint8Array | null
  /** JSON-encoded `SurfaceOp` — how the event entered the surface, or null. */
  surface_op: string | null
  /** Packed-row discriminator `0`, scalar ignorable marker `1`, or null. */
  ignorable: number | null
}

/**
 * Journal modes the backend will run under. `wal` is the default and the
 * durability model the persistence ADR records; the rollback-journal modes
 * (`delete`/`truncate`/`persist`) exist for filesystems where WAL's
 * shared-memory files do not work (network mounts). `memory`/`off` are
 * excluded: dropping journal durability silently contradicts what this
 * backend promises.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

interface SchemaObjectRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS persistence_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    store_id  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    version          INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    cwd              TEXT,
    parent_session   TEXT,
    seed_length      INTEGER,
    origin           TEXT,
    delegation_depth INTEGER,
    agent_preset     TEXT,
    incarnation      TEXT NOT NULL,
    revision         INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS events (
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,
    type              TEXT NOT NULL,
    time              INTEGER NOT NULL,
    data              ANY NOT NULL,
    source_event_seqs ANY,
    surface_op        TEXT,
    ignorable         INTEGER CHECK (
      ignorable IS NULL OR ignorable = 1 OR (
        ignorable = 0
        AND type IN ('text-chunks', 'reasoning-chunks', 'tool-call-chunks')
        AND source_event_seqs IS NULL
        AND surface_op IS NULL
      )
    ),
    PRIMARY KEY (session_id, seq)
  ) STRICT;
`

/**
 * Open the database and apply its schema and pragmas. An empty database with a
 * zero `user_version` is initialized at {@link SCHEMA_VERSION}; a nonempty
 * unversioned database and every other non-current version reject rather than
 * being migrated in place.
 * @param path - the SQLite database file to open (created when absent).
 * @param journalMode - validated journal pragma.
 * @param busyTimeoutMs - maximum synchronous wait for a competing SQLite lock.
 * @returns the open handle with pragmas applied and all three tables ensured.
 */
export function openDatabase(path: string, journalMode: JournalMode, busyTimeoutMs = 5_000): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs })
  try {
    configureDatabase(db, path, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA trusted_schema = OFF')
  db.exec('PRAGMA mmap_size = 0')
  let began = false
  try {
    db.exec('BEGIN IMMEDIATE')
    began = true
    // Validate while holding the write lock so no other connection can change
    // schema ownership between inspection and initialization.
    const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count: userObjectCount } = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get() as { count: number }
    if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
      throw new Error(`session database at "${path}" has an unversioned schema or application identity`)
    }
    if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
      throw new Error(`session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`)
    }
    if (onDisk === SCHEMA_VERSION && applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
      throw new Error(
        `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
      )
    }
    db.exec(SCHEMA_SQL)
    db.prepare(
      'INSERT OR IGNORE INTO persistence_state (singleton, store_id) VALUES (1, ?)',
    ).run(randomUUID())
    if (onDisk === 0) {
      db.exec(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    validateRequiredSchema(db, path)
    db.exec('COMMIT')
    began = false
  } catch (error: unknown) {
    /* v8 ignore next -- a BEGIN failure leaves no transaction to roll back. */
    if (began) {
      /* v8 ignore next 5 -- preserve the original schema failure if SQLite also refuses rollback. */
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original SQLite failure remains the actionable cause.
      }
    }
    throw error
  }
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  // Apply it only after ownership validation and initialization commit.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  db.exec('PRAGMA synchronous = FULL')
}

let canonicalSchema: readonly SchemaObjectRow[] | undefined

function schemaObjects(db: DatabaseSync): SchemaObjectRow[] {
  return (db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`,
  ).all() as unknown as SchemaObjectRow[]).map(row => ({
    ...row,
    sql: row.sql.replaceAll(/\s+/gu, ' ').trim(),
  }))
}

function expectedSchema(): readonly SchemaObjectRow[] {
  if (canonicalSchema !== undefined) return canonicalSchema
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec('PRAGMA foreign_keys = ON')
    reference.exec(SCHEMA_SQL)
    canonicalSchema = schemaObjects(reference)
    return canonicalSchema
  } finally {
    reference.close()
  }
}

function validateRequiredSchema(db: DatabaseSync, path: string): void {
  if (JSON.stringify(schemaObjects(db)) !== JSON.stringify(expectedSchema())) {
    throw new Error(`session database at "${path}" does not contain the required schema objects`)
  }
}

/**
 * Recheck database identity and schema while the caller holds a write lock.
 * @param db - open SQLite handle owned by the persistence backend.
 * @param path - database path included in schema diagnostics.
 */
export function validateSchemaForMutation(db: DatabaseSync, path: string): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  if (applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
    throw new Error(`session database application id changed before mutation (expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}, got ${applicationId})`)
  }
  validateRequiredSchema(db, path)
  if (version !== SCHEMA_VERSION) {
    throw new Error(`session database schema changed before mutation (expected ${SCHEMA_VERSION}, got ${version})`)
  }
}

/**
 * Reconstruct the {@link SessionHeader} from a `sessions` row.
 * @param row - the `sessions` table row.
 * @returns the header, `NULL` columns mapped to omitted optional fields.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) {
    throw new Error('stored session createdAt must be a non-negative safe integer')
  }
  return {
    version: row.version,
    id: row.id as SessionId,
    createdAt: row.created_at,
    ...row.cwd !== null ? { cwd: row.cwd } : {},
    ...row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {},
    ...row.seed_length !== null ? { seedLength: row.seed_length } : {},
    ...row.origin !== null ? { origin: row.origin } : {},
    ...row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {},
    ...row.agent_preset !== null ? { agentProfile: row.agent_preset } : {},
  }
}

/**
 * Reconstruct a {@link SessionEvent} from an `events` row (parses `data`).
 * @param row - scalar `events` row; payload data may be text or a Zstandard frame.
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(row: EventRow): SessionEvent {
  return decodeScalarRow(row)
}

/**
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by seq ascending.
 * @param base - the seq the first row is expected to carry; `0` for a whole
 *   log, the requested `fromSeq` for a suffix read (`loadStoredFrom`).
 * @returns the preserved event prefix, plus `tornFrom` — the seq the physical
 *   delete starts at — when a torn tail exists.
 */
export function scanRows(rows: readonly EventRow[], base = 0): { preserved: SessionEvent[]; tornFrom?: number } {
  return scanPhysicalRows(rows, base)
}
