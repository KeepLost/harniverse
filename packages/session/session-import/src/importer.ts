/**
 * The import runtime: read one foreign session artifact, map its history
 * lossily into native events under the archival `import/record` marker,
 * persist the mapped session, and retain the source artifact beside it.
 * Imported sessions are settled data; this plugin's Agent admission policy
 * refuses their adoption as live identities.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { Service } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SupervisionMode } from '@deepseek-ai/dsh-supervision'
import { assertNotResumable, classifyForeignSessionFormatVersion, parseImportPosture } from './contract.ts'
import { ForeignLogError, parseForeignSessionLog } from './foreign.ts'
import { mapForeignSessionEvents, scheduleImportEvents, type PendingImportEvent } from './map.ts'
import type { ForeignSessionFormat, ImportRecordEventData } from './types.ts'

/** One import request: the artifact to read plus optional target and posture. */
export interface ImportForeignSessionOptions {
  /** Filesystem path to the foreign artifact (an official v1/v2/v3 JSONL export). */
  readonly artifactPath?: string
  /** Exact uploaded source bytes; mutually exclusive with artifactPath. */
  readonly artifact?: Uint8Array
  /** Authorized destination workspace, resolved by the calling consumer. */
  readonly cwd: string
  /** Target session id; a fresh import identity when omitted. */
  readonly sessionId?: SessionId
  /** Explicit posture; omitted applies the contract default (`'supervised'`). */
  readonly posture?: { readonly supervisionMode: SupervisionMode }
}

/** The settled result of one completed import. */
export interface ImportedSession {
  /** The persisted archival session's id. */
  readonly sessionId: SessionId
  /** The classified foreign generation that was mapped. */
  readonly format: Exclude<ForeignSessionFormat, 'current' | 'unknown'>
  /** The retained source artifact's base name, beside the mapped session. */
  readonly artifactName: string
  /** How many foreign events mapped into the archival log. */
  readonly mappedEvents: number
  /** How many foreign events mapped to nothing (lossily dropped). */
  readonly skippedEvents: number
}

/** The artifact name stored beside the mapped session for one import id. */
function artifactNameFor(sessionId: SessionId): string {
  return `${encodeURIComponent(sessionId)}.source.jsonl`
}

/** Flush directory entries before publishing a log referring to the source. */
async function syncDirectory(path: string): Promise<void> {
  // Windows file handles support FlushFileBuffers; directory fsync is POSIX-only.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionImport: SessionImport
  }
}

/**
 * Import foreign session logs as archival native sessions. The service owns
 * the whole settlement — classification refusal, lossy mapping, durable
 * persistence, and source-artifact retention happen together or not at all.
 */
export class SessionImport extends Service {
  static inject = ['sessionPersistence']

  constructor(ctx: Context) {
    super(ctx, 'sessionImport')
    ctx.inject(['agents'], (inner) => {
      inner.effect(() => inner.agents.registerAdmission((session) => {
        const first = session.eventAt(0)
        assertNotResumable(first === undefined ? [] : [first])
      }), 'session-import: archival admission')
    })
  }

  /**
   * Import one foreign artifact as a settled archival session.
   * @param options - source bytes or path, authorized destination workspace, and optional target/posture.
   * @returns the imported session's identity and lossy-mapping counts.
   * @throws when the artifact cannot be read or parsed, its version is
   * `current` (native logs restore, not import) or unknown, the posture is
   * invalid, the target id already exists, or the backend cannot preserve
   * the source artifact beside the mapped session.
   */
  async import(options: ImportForeignSessionOptions): Promise<ImportedSession> {
    const posture = parseImportPosture(options.posture)
    if (!isAbsolute(options.cwd)) throw new TypeError('import requires an absolute destination workspace')
    if ((options.artifactPath === undefined) === (options.artifact === undefined)) {
      throw new TypeError('supply exactly one artifactPath or artifact')
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the exclusive-source check above requires a path without uploaded bytes
    const bytes = options.artifact === undefined ? await readFile(options.artifactPath!) : Buffer.from(options.artifact)
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded
    const log = parseForeignSessionLog(text)
    const classification = classifyForeignSessionFormatVersion(log.header.version)
    if (classification === 'current') {
      throw new ForeignLogError(`cannot import ${options.artifactPath}: its version ${String(log.header.version)} is this build's native format — restore it instead`)
    }
    if (classification === 'unknown') {
      throw new ForeignLogError(`cannot import ${options.artifactPath}: unknown session format version ${JSON.stringify(log.header.version)}`)
    }

    const sessionId = options.sessionId ?? SessionId(`session-imported-${randomUUID()}`)
    const artifactName = artifactNameFor(sessionId)
    const createdAt = log.header.createdAt
    const mapping = mapForeignSessionEvents(log, createdAt)
    const marker: PendingImportEvent = {
      type: 'import/record',
      time: createdAt,
      data: {
        source: { format: classification, artifactName },
        posture: { supervisionMode: posture.supervisionMode },
      } satisfies ImportRecordEventData,
    }
    const tail: PendingImportEvent = {
      type: 'user/message', time: mapping.events.at(-1)?.time ?? createdAt, surfaceOp: 'append',
      data: createUserMessage({
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-session-import' },
        content: [{ type: 'text', text: `Imported archival history from ${classification}, session ${JSON.stringify(log.header.id)}${log.header.cwd === undefined ? '' : `, source workspace ${JSON.stringify(log.header.cwd)}`}. Unsupported history was mapped lossily; the original bytes are retained in ${artifactName}. This session cannot execute.` }],
      }),
    }
    const events: SessionEvent[] = scheduleImportEvents(marker, [...mapping.events, tail])

    const persistence: SessionPersistence = this.ctx.sessionPersistence
    const header = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt,
      cwd: options.cwd,
    }
    const location = persistence.locate(header)
    if (location === undefined) {
      throw new Error('cannot import: this persistence backend exposes no per-session artifact location to retain the source beside')
    }

    // Validate the complete native fold while still detached and unpublished.
    Session.create(sessionId, events, header)
    const artifactDir = dirname(location.path)
    await mkdir(dirname(artifactDir), { recursive: true, mode: 0o700 })
    // Exclusive directory ownership prevents a failed contender from removing
    // another import's source or overwriting an existing session artifact.
    await mkdir(artifactDir, { mode: 0o700 })
    let created = false
    try {
      const source = await open(join(artifactDir, artifactName), 'wx', 0o600)
      try { await source.writeFile(bytes); await source.sync() } finally { await source.close() }
      await syncDirectory(artifactDir)
      await syncDirectory(dirname(artifactDir))
      await persistence.create(header)
      created = true
      await persistence.append(sessionId, events)
    } catch (error) {
      // If rollback fails, retain the source beside any surviving mapped log.
      if (created) await persistence.delete(sessionId)
      await rm(artifactDir, { recursive: true, force: true })
      throw error
    }

    return {
      sessionId,
      format: classification,
      artifactName,
      mappedEvents: mapping.events.length,
      skippedEvents: mapping.skipped,
    }
  }
}

export default SessionImport
