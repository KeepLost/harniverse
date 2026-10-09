/**
 * The import runtime: read one foreign session artifact (plain JSONL or a
 * Zstandard-framed log), map its history lossily into native events under the
 * archival `import/record` marker, persist the mapped session under a
 * content-derived identity, and retain the exact source bytes beside it.
 * Imported sessions are settled data; this plugin's Agent admission policy
 * refuses their adoption as live identities, and its projection unit reports
 * their provenance to clients.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { Service } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { decodeZstdArtifact, isZstdArtifact } from '@deepseek-ai/dsh-session-persistence-jsonl'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SupervisionMode } from '@deepseek-ai/dsh-supervision'
import { z } from 'zod'
import {
  assertNotResumable, classifyForeignSessionFormatVersion, importedSessionIdFor, importLineageOf, parseImportPosture,
} from './contract.ts'
import { SESSION_IMPORT_PLUGIN } from './continuation.ts'
import { ForeignLogError, parseForeignSessionLog, type ForeignSessionLog } from './foreign.ts'
import { mapForeignSessionEvents, scheduleImportEvents, type ForeignMapping, type PendingImportEvent } from './map.ts'
import type { ImportedSessionFormat, SessionImportProjection } from './projection.ts'
import { leadingGraphemes } from './text.ts'
import type { ImportRecordEventData } from './types.ts'

/** One import request: the artifact to read plus optional target and posture. */
export interface ImportForeignSessionOptions {
  /** Filesystem path to the foreign artifact (an official v1/v2/v3/v4 JSONL or Zstandard log). */
  readonly artifactPath?: string
  /** Exact uploaded source bytes; mutually exclusive with artifactPath. */
  readonly artifact?: Uint8Array
  /** Authorized destination workspace, resolved by the calling consumer. */
  readonly cwd: string
  /** Target session id; the content-derived archive identity when omitted. */
  readonly sessionId?: SessionId
  /** Explicit posture; omitted applies the contract default (`'supervised'`). */
  readonly posture?: { readonly supervisionMode: SupervisionMode }
}

/** The settled result of one completed import. */
export interface ImportedSession {
  /** The persisted archival session's id. */
  readonly sessionId: SessionId
  /** The classified foreign generation that was mapped. */
  readonly format: ImportedSessionFormat
  /** The retained source artifact's base name, beside the mapped session. */
  readonly artifactName: string
  /** The foreign session's own id. */
  readonly sourceSessionId: string
  /** The imported title, when the source recorded a usable one. */
  readonly title?: string
  /** How many foreign events mapped into the archival log. */
  readonly mappedEvents: number
  /** How many foreign events mapped to nothing (lossily dropped). */
  readonly skippedEvents: number
}

/** What an artifact would import as, read without persisting anything. */
export interface ForeignArtifactSummary {
  /** The classified foreign generation. */
  readonly format: ImportedSessionFormat
  /** The foreign session's own id. */
  readonly sourceSessionId: string
  /** The foreign working directory, as provenance. */
  readonly sourceCwd: string | undefined
  /** Foreign creation time, Unix epoch milliseconds. */
  readonly createdAt: number
  /** Time of the latest foreign event, or `createdAt` for an empty log. */
  readonly updatedAt: number
  /** The latest usable foreign title. */
  readonly title: string | undefined
  /** The first human prompt's text, one line, at most {@link PREVIEW_MAX_CHARACTERS} graphemes. */
  readonly preview: string | undefined
  /** How many turns the mapped history holds. */
  readonly turns: number
  /** The archive identity importing this exact text would mint. */
  readonly sessionId: SessionId
  /** The id prefix shared by every archive of the same foreign session. */
  readonly lineage: string
}

/** Grapheme budget of {@link ForeignArtifactSummary.preview}. */
const PREVIEW_MAX_CHARACTERS = 160

/** An import whose content-derived archive identity already exists. */
export class ImportConflictError extends Error {
  /**
   * @param sessionId - the existing archive's id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`this session was already imported as "${sessionId}"`)
    this.name = 'ImportConflictError'
  }
}

/** The artifact name stored beside the mapped session for one import id. */
function artifactNameFor(sessionId: SessionId, compressed: boolean): string {
  return `${encodeURIComponent(sessionId)}.source.jsonl${compressed ? '.zstd' : ''}`
}

/** Flush directory entries before publishing a log referring to the source. */
async function syncDirectory(path: string): Promise<void> {
  // Windows file handles support FlushFileBuffers; directory fsync is POSIX-only.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** One decoded, classified, and mapped artifact. */
interface PreparedArtifact {
  readonly bytes: Uint8Array
  readonly compressed: boolean
  readonly text: string
  readonly log: ForeignSessionLog
  readonly format: ImportedSessionFormat
  readonly mapping: ForeignMapping
}

/**
 * Decode, classify, and map one foreign artifact.
 * @param bytes - the exact source bytes.
 * @param label - how diagnostics name the artifact.
 * @returns the prepared artifact.
 * @throws {@link ForeignLogError} for undecodable, native, unknown, or malformed logs.
 */
function prepareArtifact(bytes: Uint8Array, label: string): PreparedArtifact {
  const compressed = isZstdArtifact(bytes)
  let plain: Uint8Array = bytes
  if (compressed) {
    try {
      plain = decodeZstdArtifact(bytes)
    } catch (error) {
      throw new ForeignLogError(`cannot import ${label}: its Zstandard framing is corrupt: ${String(error)}`)
    }
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain)
  } catch {
    throw new ForeignLogError(`cannot import ${label}: it is not UTF-8 text`)
  }
  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded
  const log = parseForeignSessionLog(text)
  const classification = classifyForeignSessionFormatVersion(log.header.version)
  if (classification === 'current') {
    throw new ForeignLogError(`cannot import ${label}: its version ${String(log.header.version)} is this build's native format — restore it instead`)
  }
  if (classification === 'unknown') {
    throw new ForeignLogError(`cannot import ${label}: unknown session format version ${JSON.stringify(log.header.version)}`)
  }
  return { bytes, compressed, text, log, format: classification, mapping: mapForeignSessionEvents(log, log.header.createdAt) }
}

/** The latest mapped title, when the mapping produced one. */
function mappedTitle(mapping: ForeignMapping): string | undefined {
  const event = mapping.events.findLast(candidate => candidate.type === 'session/title')
  return event?.type === 'session/title' ? event.data.title : undefined
}

/** The first human prompt's text as one line. */
function mappedPreview(mapping: ForeignMapping): string | undefined {
  for (const event of mapping.events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text === '') continue
    return leadingGraphemes(text, PREVIEW_MAX_CHARACTERS)
  }
  return undefined
}

const importedFormatSchema = z.enum(['official-v1', 'official-v2', 'official-v3', 'official-v4'])

const sessionImportProjectionSchema: z.ZodType<SessionImportProjection | null> = z.object({
  format: importedFormatSchema,
  sourceSessionId: z.string().exactOptional(),
  sourceCwd: z.string().exactOptional(),
}).nullable()

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
    // The unit child activates only when a projection registry is composed
    // (headless assemblies stay unaffected).
    ctx.inject(['sessionProjections'], (inner) => {
      inner.sessionProjections.register<'sessionImport', SessionImportProjection | null>({
        key: 'sessionImport',
        schema: sessionImportProjectionSchema,
        init: () => null,
        apply: (state, event) => {
          if (event.type !== 'import/record' || event.seq !== 0) return state
          const { format, sessionId, cwd } = event.data.source
          return {
            format,
            ...sessionId === undefined ? {} : { sourceSessionId: sessionId },
            ...cwd === undefined ? {} : { sourceCwd: cwd },
          }
        },
        view: state => state,
        stateVersion: 1,
      })
    })
  }

  /**
   * Read what one foreign artifact would import as, without persisting.
   * @param artifact - the exact source bytes (plain JSONL or Zstandard-framed).
   * @returns the artifact's provenance, display facts, and archive identity.
   * @throws {@link ForeignLogError} when the artifact cannot be decoded,
   * parsed, classified as an official generation, or mapped.
   */
  describe(artifact: Uint8Array): ForeignArtifactSummary {
    const prepared = prepareArtifact(artifact, 'the artifact')
    const { header, events } = prepared.log
    // The parser admits only safe-integer event times.
    const updatedAt = events.reduce((latest, event) => Math.max(latest, event.time as number), header.createdAt)
    return {
      format: prepared.format,
      sourceSessionId: header.id,
      sourceCwd: header.cwd,
      createdAt: header.createdAt,
      updatedAt,
      title: mappedTitle(prepared.mapping),
      preview: mappedPreview(prepared.mapping),
      turns: prepared.mapping.events.filter(event => event.type === 'turn/start').length,
      sessionId: importedSessionIdFor(header.id, prepared.text),
      lineage: importLineageOf(header.id),
    }
  }

  /**
   * Import one foreign artifact as a settled archival session.
   * @param options - source bytes or path, authorized destination workspace, and optional target/posture.
   * @returns the imported session's identity and lossy-mapping counts.
   * @throws {@link ImportConflictError} when the archive identity already
   * exists; {@link ForeignLogError} when the artifact cannot be decoded,
   * parsed, or mapped, or its version is `current` (native logs restore, not
   * import) or unknown; `TypeError` for an invalid posture or destination;
   * and an `Error` when the backend cannot preserve the source artifact
   * beside the mapped session.
   */
  async import(options: ImportForeignSessionOptions): Promise<ImportedSession> {
    const posture = parseImportPosture(options.posture)
    if (!isAbsolute(options.cwd)) throw new TypeError('import requires an absolute destination workspace')
    if ((options.artifactPath === undefined) === (options.artifact === undefined)) {
      throw new TypeError('supply exactly one artifactPath or artifact')
    }
    const label = options.artifactPath ?? 'the uploaded artifact'
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the exclusive-source check above requires a path without uploaded bytes
    const bytes = options.artifact === undefined ? await readFile(options.artifactPath!) : Buffer.from(options.artifact)
    const prepared = prepareArtifact(bytes, label)
    const { log, mapping } = prepared

    const persistence: SessionPersistence = this.ctx.sessionPersistence
    const sessionId = options.sessionId ?? importedSessionIdFor(log.header.id, prepared.text)
    // Identity is global across project directories: a second directory with
    // the same id would make the backend's listing ambiguous.
    if ((await persistence.list()).some(existing => existing.id === sessionId)) {
      throw new ImportConflictError(sessionId)
    }
    const artifactName = artifactNameFor(sessionId, prepared.compressed)
    const createdAt = log.header.createdAt
    const marker: PendingImportEvent = {
      type: 'import/record',
      time: createdAt,
      data: {
        source: {
          format: prepared.format,
          artifactName,
          sessionId: log.header.id,
          ...log.header.cwd === undefined ? {} : { cwd: log.header.cwd },
        },
        posture: { supervisionMode: posture.supervisionMode },
      } satisfies ImportRecordEventData,
    }
    const tail: PendingImportEvent = {
      type: 'user/message', time: mapping.events.at(-1)?.time ?? createdAt, surfaceOp: 'append',
      data: createUserMessage({
        source: { kind: 'plugin', plugin: SESSION_IMPORT_PLUGIN },
        content: [{ type: 'text', text: `Imported archival history from ${prepared.format}, session ${JSON.stringify(log.header.id)}${log.header.cwd === undefined ? '' : `, source workspace ${JSON.stringify(log.header.cwd)}`}. Unsupported history was mapped lossily; the original bytes are retained in ${artifactName}. This session cannot execute.` }],
      }),
    }
    const events: SessionEvent[] = scheduleImportEvents(marker, [...mapping.events, tail])

    const header: SessionHeader = {
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
    try {
      await mkdir(artifactDir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImportConflictError(sessionId)
      throw error
    }
    let created = false
    try {
      const source = await open(join(artifactDir, artifactName), 'wx', 0o600)
      try { await source.writeFile(prepared.bytes); await source.sync() } finally { await source.close() }
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
    this.ctx.emit('session/imported', header)

    const title = mappedTitle(mapping)
    return {
      sessionId,
      format: prepared.format,
      artifactName,
      sourceSessionId: log.header.id,
      ...title === undefined ? {} : { title },
      mappedEvents: mapping.events.length,
      skippedEvents: mapping.skipped,
    }
  }
}

export default SessionImport
