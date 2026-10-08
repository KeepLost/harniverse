/**
 * Durable registry of managed chat bots: `$DSH_HOME/chat-bots.json`, a
 * schema-validated document replaced atomically with owner-only permissions.
 * It holds identities, non-secret field values, and the keys of secret fields;
 * a secret value is never written here — it lives in the credential store.
 * @module @deepseek-ai/dsh-chat-manager/registry
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatBotSettingsView } from './types.ts'

/** Most bots one registry holds; bounds the document. */
export const MAX_BOTS = 32

/** Largest document the loader accepts. */
const MAX_DOCUMENT_BYTES = 1024 * 1024

const text = (max: number): z.ZodString => z.string().min(1).max(max)

const recordSchema = z.strictObject({
  id: z.string().regex(/^bot_[0-9a-f]{8}$/u),
  platform: text(64),
  alias: text(64),
  identity: z.strictObject({ botId: text(256), displayName: text(256) }),
  values: z.record(text(64), z.string().max(4096)),
  secretKeys: z.array(text(64)).max(16),
  enabled: z.boolean(),
  settings: z.strictObject({
    workspace: text(4096).optional(),
    model: z.strictObject({ provider: text(256), model: text(256), reasoningEffort: text(64).optional() }).optional(),
    agentProfile: text(128).optional(),
  }),
  createdAt: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative().optional(),
}).refine(record => record.secretKeys.every(key => !(key in record.values)), { message: 'a secret key must not carry a stored value' })

const documentSchema = z.strictObject({ version: z.literal(1), bots: z.array(z.unknown()).max(MAX_BOTS) })

/** One persisted bot. */
export interface BotRecord {
  /** `bot_` followed by eight lowercase hexadecimal digits. */
  id: string
  platform: string
  alias: string
  /** Identity the platform reported at the last successful check. */
  identity: { botId: string; displayName: string }
  /** Non-secret field values. */
  values: Record<string, string>
  /** Keys of the secret fields whose values sit in the credential store. */
  secretKeys: string[]
  enabled: boolean
  settings: ChatBotSettingsView
  createdAt: number
  checkedAt?: number
}

/**
 * Parse one untrusted record into a detached, validated copy.
 * @param value - candidate record.
 * @returns the validated record.
 */
function parseRecord(value: unknown): BotRecord {
  // JSON detachment drops explicitly undefined optional fields after validation.
  return JSON.parse(JSON.stringify(recordSchema.parse(value))) as BotRecord
}

/** Single-process registry; the composing app owns the Harness home. */
export class BotRegistry {
  private records: BotRecord[] = []
  private tail: Promise<void> = Promise.resolve()
  /** Absolute registry file path. */
  readonly path: string

  /** @param home - Harness home directory holding `chat-bots.json`. */
  constructor(private readonly home: string) {
    this.path = join(home, 'chat-bots.json')
  }

  /**
   * Load and validate the registry file; a missing file is an empty registry.
   * @throws when the file is not a regular file, is oversized, or fails validation; the message names the path only.
   */
  async load(): Promise<void> {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw this.invalid(error)
    }
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw this.invalid()
    try {
      const document = documentSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      const records = document.bots.map(parseRecord)
      if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('duplicate id')
      this.records = records
    } catch (error) {
      throw this.invalid(error)
    }
  }

  /**
   * Read every record.
   * @returns detached copies, in registration order.
   */
  list(): BotRecord[] {
    return structuredClone(this.records)
  }

  /**
   * Read one record.
   * @param id - bot id.
   * @returns a detached copy, or undefined for an unknown id.
   */
  get(id: string): BotRecord | undefined {
    const record = this.records.find(candidate => candidate.id === id)
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * Insert or replace one validated record; a replacement keeps its position.
   * @param record - record to persist.
   * @returns resolves once the document is durable.
   */
  put(record: BotRecord): Promise<void> {
    return this.commit((records) => {
      const detached = parseRecord(record)
      const index = records.findIndex(candidate => candidate.id === detached.id)
      if (index < 0) return [...records, detached]
      return records.map((candidate, position) => position === index ? detached : candidate)
    })
  }

  /**
   * Delete one record; an unknown id is a no-op.
   * @param id - bot id.
   * @returns resolves once the document is durable.
   */
  remove(id: string): Promise<void> {
    return this.commit(records => records.filter(candidate => candidate.id !== id))
  }

  private invalid(cause?: unknown): Error {
    return new Error(`chat-manager: ${this.path} is not a valid chat bot registry`, cause === undefined ? undefined : { cause })
  }

  private commit(change: (records: BotRecord[]) => BotRecord[]): Promise<void> {
    const work = this.tail.then(async () => {
      const records = change(this.records)
      if (records.length > MAX_BOTS) throw new Error('chat-manager: too many bots')
      const serialized = JSON.stringify({ version: 1, bots: records }) + '\n'
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      const temporary = join(this.home, `.chat-bots-${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(serialized)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, this.path)
        this.records = records
      } finally {
        await rm(temporary, { force: true })
      }
    })
    // A rejected commit must not poison later ones.
    this.tail = work.catch(() => {})
    return work
  }
}
