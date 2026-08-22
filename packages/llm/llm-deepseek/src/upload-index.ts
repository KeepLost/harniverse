/** Durable DeepSeek attachment-to-file-id cache. */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, ImageVariantId as ImageVariantIdType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId, DeepSeekFileScope } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType, DeepSeekFileScope as DeepSeekFileScopeType } from './file-id.ts'

/** One provider upload mapping. Times are Unix milliseconds. */
export interface DeepSeekUploadRecord {
  scope: DeepSeekFileScopeType
  attachmentId: AttachmentId
  variantId: ImageVariantIdType
  fileId: DeepSeekFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex {
  formatVersion: 1
  records: DeepSeekUploadRecord[]
}

class InvalidUploadIndexError extends Error {}

/** Result of committing one candidate mapping under the index lock. */
export interface UploadIndexCommit {
  record: DeepSeekUploadRecord
  accepted: boolean
}

/** Derive a non-secret scope without persisting or logging the API key.
 * @param baseURL - normalized provider endpoint.
 * @param apiKey - request credential, never returned or persisted.
 * @returns endpoint/API-key scope digest.
 */
export function deepSeekFileScope(baseURL: string, apiKey: string): DeepSeekFileScopeType {
  const digest = createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex')
  return DeepSeekFileScope(digest)
}

function parseRecord(value: unknown): DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains a non-object record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(record.scope)
    || typeof record.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)
    || typeof record.variantId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains an invalid record')
  }
  return {
    scope: DeepSeekFileScope(record.scope),
    attachmentId: record.attachmentId as AttachmentId,
    variantId: ImageVariantId(record.variantId),
    fileId: DeepSeekFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  }
}

function parseIndex(text: string): StoredIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not an object')
  }
  const index = value as { formatVersion?: unknown; records?: unknown }
  if (index.formatVersion !== 1 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('llm-deepseek: unsupported upload index format')
  }
  const records = index.records.map(parseRecord)
  const keys = new Set<string>()
  for (const record of records) {
    const key = `${record.scope}\0${record.variantId}`
    if (keys.has(key)) throw new InvalidUploadIndexError('llm-deepseek: duplicate upload mapping')
    keys.add(key)
  }
  return { formatVersion: 1, records }
}

function reusable(record: DeepSeekUploadRecord, now: number, marginMs: number): boolean {
  return record.expiresAt - now > marginMs
}

/** Atomic local index shared by DeepSeek sessions in one DSH home. */
export class DeepSeekUploadIndex {
  /** Absolute path of the provider-local JSON index. */
  readonly path: string

  constructor(path = join(resolveDshHome(), 'llm-deepseek', 'files-v1.json')) {
    this.path = path
  }

  private async load(): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || error instanceof InvalidUploadIndexError) {
        return { formatVersion: 1, records: [] }
      }
      throw error
    }
  }

  private async save(index: StoredIndex): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(index, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /** Read one reusable mapping outside the write lock.
   * @param scope - endpoint/API-key scope.
   * @param variantId - request-image variant.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - required remaining lifetime.
   * @returns a reusable mapping, when present.
   */
  async get(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    now: number,
    refreshMarginMs: number,
  ): Promise<DeepSeekUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ))
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  /** Commit one mapping, deduplicating a concurrent valid mapping.
   * @param candidate - provider mapping to persist.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - required remaining lifetime.
   * @returns whether this candidate became the stored mapping.
   */
  async commit(
    candidate: DeepSeekUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadIndexCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ))
      if (existing !== undefined) return { record: existing, accepted: false }
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ))
      records.push(candidate)
      await this.save({ formatVersion: 1, records })
      return { record: candidate, accepted: true }
    })
  }

  /** Remove one exact mapping under the index lock.
   * @param scope - endpoint/API-key scope.
   * @param variantId - request-image variant.
   * @param fileId - provider file id.
   */
  async remove(scope: DeepSeekFileScopeType, variantId: ImageVariantIdType, fileId: DeepSeekFileIdType): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(
        record.scope === scope && record.variantId === variantId && record.fileId === fileId
      ))
      if (records.length !== index.records.length) await this.save({ formatVersion: 1, records })
    })
  }

  /** Remove all mappings for one endpoint/API-key scope.
   * @param scope - endpoint/API-key scope.
   */
  async clear(scope: DeepSeekFileScopeType): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => record.scope !== scope)
      if (records.length !== index.records.length) await this.save({ formatVersion: 1, records })
    })
  }
}
