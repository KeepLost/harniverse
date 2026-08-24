/**
 * SQLite durable session-persistence backend. It maps each session header and
 * logical event stream to scalar or packed physical rows, then delegates write
 * orchestration to {@link PersistenceCoordinator}. It has no per-session artifact,
 * so its locator returns `undefined`.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator, replacementCheckpointStart,
  CHECKPOINT_SEARCH_MESSAGE_BUDGET,
  type PersistenceBackend, type SessionLocation, type SessionPersistenceSnapshot,
  type SessionInspection, type SessionPersistenceRevision as PersistenceRevision,
  type SessionHistoryPageRequest, type StoredHistoryPage, type StoredPrefix, type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { EpochHeader, SessionEvent, SessionId, SessionHeader, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  type JournalMode, openDatabase, rowToMeta, scanRows, type EventRow, type SessionRow, validateSchemaForMutation,
} from './schema.ts'
import { rowToEvent } from './schema.ts'
import { bindRecord, decodeRow } from './compression.ts'
import { MAX_PACKED_ROW_MEMBERS, packChunkRuns } from './codec.ts'

export { SCHEMA_VERSION } from './schema.ts'

/** Build the source-qualified revision shared by full and lightweight reads. */
function sqliteRevision(storeIdentity: string, row: SessionRow): PersistenceRevision {
  return SessionPersistenceRevision(
    `${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its parent
 * directory.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function validateParentDirectory(path: string): Promise<void> {
  const parent = await lstat(path)
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`session database parent "${path}" must be a real directory`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && (parent.uid !== uid || (parent.mode & 0o022) !== 0)) {
    throw new Error(`session database parent "${path}" must be owned by the current user and not group/world-writable`)
  }
}

async function validateDatabaseFile(path: string): Promise<void> {
  const file = await lstat(path)
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`session database "${path}" must be a regular file, not a symbolic link`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && (file.uid !== uid || (file.mode & 0o077) !== 0)) {
    throw new Error(`session database "${path}" must be owned by the current user and accessible only by that user`)
  }
}

async function validateDatabaseFileIfPresent(path: string): Promise<void> {
  try {
    await validateDatabaseFile(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). On filesystems with POSIX modes,
   * missing directories and databases are created owner-only. Existing paths
   * must be real, owner-only, and owned by the effective user. Filesystem setup
   * errors fail initialization. The backend does not encrypt the database.
   */
  path: string
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) is the recorded
   * durability model; pick a rollback-journal mode (`delete`/`truncate`/
   * `persist`) on filesystems where WAL's shared-memory files do not work
   * (network mounts). See {@link JournalMode}.
   */
  journalMode?: JournalMode
  /** Maximum synchronous wait for another SQLite writer. */
  busyTimeoutMs?: number
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/**
 * The SQLite persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the seq to delete from.
 */
export class SqliteSessionPersistence extends SessionPersistence implements PersistenceBackend<number> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    busyTimeoutMs: z.number().step(1).min(1).default(5000),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  override readonly name = 'session-persistence-sqlite'

  private db!: DatabaseSync
  private databasePath!: string
  private storeIdentity!: string
  private ready: Promise<void>
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic wrappers may construct the backend without Schemastery normalization.
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const busyTimeoutMs = config.busyTimeoutMs ?? 5000
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    // Open asynchronously so directory creation does not block plugin apply;
    // every storage hook awaits the same readiness promise.
    this.ready = this.openDb(config.path, (config as Required<Config>).journalMode, busyTimeoutMs)
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  private async openDb(path: string, journalMode: JournalMode, busyTimeoutMs: number): Promise<void> {
    const actual = path === ':memory:' ? path : resolve(path)
    this.databasePath = actual
    if (actual !== ':memory:') {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
      await validateParentDirectory(dirname(actual))
      await validateDatabaseFileIfPresent(actual)
      await createDatabaseFile(actual)
      await validateDatabaseFile(actual)
    }
    this.db = openDatabase(actual, journalMode, busyTimeoutMs)
    try {
      const row = this.db.prepare(
        'SELECT store_id FROM persistence_state WHERE singleton = 1',
      ).get() as { store_id: string } | undefined
      /* v8 ignore next -- openDatabase inserts the singleton before returning. */
      if (row === undefined) {
        throw new Error(`session database at "${actual}" has no store identity`)
      }
      if (row.store_id.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`)
      }
      if (actual !== ':memory:') {
        const identity = statSync(actual, { bigint: true })
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${row.store_id}`
      } else {
        this.storeIdentity = `memory:store:${row.store_id}`
      }
    } catch (error: unknown) {
      this.db.close()
      throw error
    }
  }

  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** SQLite has one database, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  delete(id: SessionId): Promise<boolean> {
    return this.coordinator.delete(id)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  override readRequestHeader(id: SessionId, signal?: AbortSignal): Promise<EpochHeader | undefined> {
    return this.coordinator.readRequestHeader(id, signal)
  }

  override readHistoryPage(
    id: SessionId,
    request: SessionHistoryPageRequest,
    signal?: AbortSignal,
  ): Promise<StoredHistoryPage & { readonly meta: SessionHeader }> {
    return this.coordinator.readHistoryPage(id, request, signal)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the SQLite storage primitives) ---

  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id, signal)
  }

  /** Read one row's revision without loading its events. */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    return row === undefined ? undefined : sqliteRevision(this.storeIdentity, row)
  }

  /**
   * Seek-capable suffix read. SQL includes only the bounded packed predecessor
   * that may cover `fromSeq` plus physical rows at or after the resolved base.
   * Torn rows past the preserved region are dropped, never repaired.
   */
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    if (row === undefined) return undefined
    const meta = rowToMeta(row)
    const { base, eventRows } = this.physicalSpanFrom(id, fromSeq)
    signal?.throwIfAborted()
    const { preserved } = scanRows(eventRows, base)
    return { meta, events: preserved.filter(event => event.seq >= fromSeq) }
  }

  /**
   * Read a backward display page without materializing the complete log. The
   * append-origin candidates identify the message cut; one contiguous range
   * query then returns all raw events needed to render that page.
   */
  async loadHistoryPage(
    id: SessionId,
    request: SessionHistoryPageRequest,
    signal?: AbortSignal,
  ): Promise<StoredHistoryPage | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    if (row === undefined) return undefined
    const upper = request.beforeSeq ?? Number.MAX_SAFE_INTEGER
    const appendRows = this.db.prepare(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM events
       WHERE session_id = ? AND seq < ?
         AND type IN ('user/message', 'assistant/message')
         AND surface_op = ?
       ORDER BY seq DESC LIMIT ?`,
    ).all(id, upper, JSON.stringify('append'), request.maxMessages) as unknown as EventRow[]
    signal?.throwIfAborted()
    let cut = 0
    if (appendRows.length === request.maxMessages) {
      const oldest = appendRows[appendRows.length - 1]
      if (oldest === undefined) throw new Error('history page candidate query returned no oldest row')
      const event = rowToEvent(oldest)
      const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
      cut = event.seq
      if (sources !== undefined) {
        for (const source of sources) {
          if (source < cut) cut = source
        }
      }
    }
    // A checkpoint can sit just past the message quota, so the search reaches
    // below the quota cut — but only past CHECKPOINT_SEARCH_MESSAGE_BUDGET
    // further messages, keeping a compaction-free session off a whole-history
    // scan (an unbounded search measured 16s+ on a 203k-event log).
    if (request.beforeSeq === undefined && request.preferLatestCheckpoint === true) {
      const searchFloorRow = this.db.prepare(
        `SELECT seq FROM events
         WHERE session_id = ? AND type IN ('user/message', 'assistant/message')
           AND surface_op = ?
         ORDER BY seq DESC LIMIT 1 OFFSET ?`,
      ).get(
        id,
        JSON.stringify('append'),
        request.maxMessages + CHECKPOINT_SEARCH_MESSAGE_BUDGET - 1,
      ) as { seq: number } | undefined
      const floor = searchFloorRow?.seq ?? 0
      const replacements = this.db.prepare(
        `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
         FROM events
         WHERE session_id = ? AND seq >= ? AND type = 'user/message'
           AND surface_op IS NOT NULL AND surface_op <> ?
         ORDER BY seq DESC`,
      ).iterate(id, floor, JSON.stringify('append')) as unknown as Iterable<EventRow>
      for (const replacement of replacements) {
        const checkpointStart = replacementCheckpointStart(rowToEvent(replacement))
        if (checkpointStart === undefined) continue
        cut = checkpointStart
        break
      }
    }
    const physical = this.physicalSpanFrom(id, cut, request.beforeSeq)
    signal?.throwIfAborted()
    const { preserved } = scanRows(physical.eventRows, physical.base)
    return {
      meta: rowToMeta(row),
      events: preserved.filter(event => event.seq >= cut && event.seq < upper),
      hasMore: cut > 0,
    }
  }

  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the seq from which a never-committed tail must be deleted
   * (`scanRows` already returns it as `number | undefined`).
   */
  private async readPrefix(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    this.db.exec('BEGIN')
    let snapshot: { row: SessionRow; eventRows: EventRow[] } | undefined
    try {
      const row = this.rowFor(id)
      if (row !== undefined) {
        const eventRows = this.db
          .prepare('SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? ORDER BY seq')
          .all(id) as unknown as EventRow[]
        snapshot = { row, eventRows }
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      /* v8 ignore start -- synchronous read failures only need transaction cleanup before propagation. */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const { row, eventRows } = snapshot
    const { preserved, tornFrom } = scanRows(eventRows)
    return {
      meta: rowToMeta(row),
      events: preserved,
      revision: sqliteRevision(this.storeIdentity, row),
      ...tornFrom !== undefined ? { tornMarker: tornFrom } : {},
    }
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every event, or roll back entirely. The transaction is the
   * atomicity + durability boundary, so a mid-batch failure (a UNIQUE violation
   * on a duplicated seq) leaves the stored log untouched.
   */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ready
    const insertEvent = this.db.prepare(
      'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      validateSchemaForMutation(this.db, this.databasePath)
      const currentLast = this.logicalLastEvent(meta.id)
      const expected = currentLast === undefined ? 0 : currentLast.seq + 1
      if (events[0]?.seq !== expected) {
        throw new Error(`session ${meta.id} append starts at seq ${events[0]?.seq}, stored next seq is ${expected}`)
      }
      if (!isMaterialized) this.writeRow(meta)
      for (const record of packChunkRuns(events)) this.insertRecord(insertEvent, meta.id, bindRecord(record))
      this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`) and INSERT the synthetic `closers`. After COMMIT the stored rows
   * == the balanced log.
   */
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ready
    this.db.exec('BEGIN IMMEDIATE')
    try {
      validateSchemaForMutation(this.db, this.databasePath)
      const currentRows = this.db.prepare(
        `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
         FROM events WHERE session_id = ? ORDER BY seq`,
      ).all(meta.id) as unknown as EventRow[]
      const current = scanRows(currentRows)
      if (tornMarker !== undefined) {
        if (current.tornFrom !== tornMarker) {
          throw new Error(`session ${meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`)
        }
        this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(meta.id, tornMarker)
      } else if (current.tornFrom !== undefined) {
        throw new Error(`session ${meta.id} repair omitted current torn tail at seq ${current.tornFrom}`)
      }
      if (closers.length > 0) {
        const expected = current.preserved.at(-1)?.seq === undefined
          ? 0
          : (current.preserved.at(-1) as SessionEvent).seq + 1
        if (closers[0]?.seq !== expected) {
          throw new Error(`session ${meta.id} repair is stale: closer starts at seq ${closers[0]?.seq}, stored next seq is ${expected}`)
        }
        const insertEvent = this.db.prepare(
          'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        for (const event of closers) this.insertRecord(insertEvent, meta.id, bindRecord(event))
      }
      if (tornMarker !== undefined || closers.length > 0) {
        this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      // The DELETE+INSERT cannot collide (a row at a closer's seq is preserved or
      // deleted as torn first); this rolls back a DB-level failure (disk full,
      // etc.), unreachable in test.
      /* v8 ignore start */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
  }

  /** Delete one metadata row and its cascading event rows atomically. */
  async deleteStored(id: SessionId): Promise<boolean> {
    await this.ready
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** List all materialized sessions' metadata (every row is a materialized session). */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const rows = this.db
      .prepare('SELECT * FROM sessions')
      .all() as unknown as SessionRow[]
    signal?.throwIfAborted()
    return rows.map(rowToMeta)
  }

  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    const rows = this.db.prepare('SELECT * FROM sessions').all() as unknown as SessionRow[]
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
      ),
    }))
  }

  /** Close the database handle (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready
    this.db.close()
  }

  // --- row helpers ---

  /** Fetch a session's row, or undefined if absent. */
  private rowFor(id: SessionId): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }

  /**
   * Insert-or-replace a session's metadata row. The only caller is the first
   * materializing `appendBatch`, so writing the row IS the materialization (its
   * existence is the signal `list` reads).
   */
  private writeRow(meta: SessionHeader): void {
    this.db.prepare(`
      INSERT INTO sessions
        (id, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session,
        seed_length = excluded.seed_length,
        origin = excluded.origin,
        delegation_depth = excluded.delegation_depth,
        agent_preset = excluded.agent_preset
    `).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.seedLength ?? null,
      meta.origin ?? null,
      meta.delegationDepth ?? null,
      meta.agentProfile ?? null,
      randomUUID(),
    )
  }

  private physicalSpanFrom(
    id: SessionId,
    fromSeq: number,
    beforeSeq?: number,
  ): { readonly base: number; readonly eventRows: EventRow[] } {
    const packedFloor = Math.max(0, fromSeq - MAX_PACKED_ROW_MEMBERS + 1)
    const predecessors = this.db.prepare(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM events
       WHERE session_id = ? AND seq >= ? AND seq < ?
         AND type IN ('text-chunks', 'reasoning-chunks', 'tool-call-chunks')
         AND ignorable = 0
       ORDER BY seq`,
    ).all(id, packedFloor, fromSeq) as unknown as EventRow[]
    let base = fromSeq
    for (const predecessor of predecessors) {
      try {
        const last = decodeRow(predecessor).at(-1)
        if (last !== undefined && last.seq >= fromSeq) base = Math.min(base, predecessor.seq)
      } catch (error: unknown) {
        throw new Error(`corrupt session log: invalid packed predecessor at seq ${predecessor.seq}`, { cause: error })
      }
    }
    const upperClause = beforeSeq === undefined ? '' : ' AND seq < ?'
    const eventRows = this.db.prepare(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM events WHERE session_id = ? AND seq >= ?${upperClause} ORDER BY seq`,
    ).all(...beforeSeq === undefined ? [id, base] : [id, base, beforeSeq]) as unknown as EventRow[]
    return { base, eventRows }
  }

  private logicalLastEvent(id: SessionId): SessionEvent | undefined {
    const tail = this.db.prepare(
      `SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
       FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 2`,
    ).all(id) as unknown as EventRow[]
    if (tail.length === 0) return undefined
    tail.reverse()
    const span = this.physicalSpanFrom(id, (tail[0] as EventRow).seq)
    const { preserved, tornFrom } = scanRows(span.eventRows, span.base)
    if (tornFrom !== undefined) throw new Error(`session ${id} has an invalid physical tail at seq ${tornFrom}`)
    return preserved.at(-1)
  }

  private insertRecord(
    insert: StatementSync,
    id: SessionId,
    record: ReturnType<typeof bindRecord>,
  ): void {
    insert.run(
      id,
      record.seq,
      record.type,
      record.time,
      record.data,
      record.sourceEventSeqs,
      record.surfaceOp,
      record.ignorable,
    )
  }
}

export default SqliteSessionPersistence
