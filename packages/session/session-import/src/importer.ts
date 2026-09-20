/**
 * The import runtime: read one foreign session artifact, map its history
 * lossily into native events under the archival `import/record` marker,
 * persist the mapped session, and retain the source artifact beside it.
 * Imported sessions are settled data — the resume guard in
 * `dsh-agent-loop` refuses them as live identities.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SupervisionMode } from '@deepseek-ai/dsh-supervision'
import { classifyForeignSessionFormatVersion, parseImportPosture } from './contract.ts'
import { parseForeignSessionLog } from './foreign.ts'
import { mapForeignSessionEvents, scheduleImportEvents, type PendingImportEvent } from './map.ts'
import type { ForeignSessionFormat, ImportRecordEventData } from './types.ts'

/** One import request: the artifact to read plus optional target and posture. */
export interface ImportForeignSessionOptions {
  /** Filesystem path to the foreign artifact (an official v1/v2/v3 JSONL export). */
  readonly artifactPath: string
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
  return `${sessionId}.source.jsonl`
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
  }

  /**
   * Import one foreign artifact as a settled archival session.
   * @param options - the artifact path plus optional target id and posture.
   * @returns the imported session's identity and lossy-mapping counts.
   * @throws when the artifact cannot be read or parsed, its version is
   * `current` (native logs restore, not import) or unknown, the posture is
   * invalid, the target id already exists, or the backend cannot preserve
   * the source artifact beside the mapped session.
   */
  async import(options: ImportForeignSessionOptions): Promise<ImportedSession> {
    const posture = parseImportPosture(options.posture)
    const text = await readFile(options.artifactPath, 'utf8')
    const log = parseForeignSessionLog(text)
    const classification = classifyForeignSessionFormatVersion(log.header.version)
    if (classification === 'current') {
      throw new Error(`cannot import ${options.artifactPath}: its version ${String(log.header.version)} is this build's native format — restore it instead`)
    }
    if (classification === 'unknown') {
      throw new Error(`cannot import ${options.artifactPath}: unknown session format version ${JSON.stringify(log.header.version)}`)
    }

    const sessionId = options.sessionId ?? SessionId(`session-imported-${randomUUID()}`)
    const artifactName = artifactNameFor(sessionId)
    const createdAt = log.header.createdAt ?? Date.now()
    const mapping = mapForeignSessionEvents(log, createdAt)
    const marker: PendingImportEvent = {
      type: 'import/record',
      time: createdAt,
      data: {
        source: { format: classification, artifactName },
        posture: { supervisionMode: posture.supervisionMode },
      } satisfies ImportRecordEventData,
    }
    const events: SessionEvent[] = scheduleImportEvents(marker, mapping.events)

    const persistence: SessionPersistence = this.ctx.sessionPersistence
    const header = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt,
      ...log.header.cwd === undefined ? {} : { cwd: log.header.cwd },
    }
    const location = persistence.locate(header)
    if (location === undefined) {
      throw new Error('cannot import: this persistence backend exposes no per-session artifact location to retain the source beside')
    }

    await persistence.create(header)
    await persistence.append(sessionId, events)
    const artifactDir = dirname(location.path)
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, artifactName), text, 'utf8')

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
