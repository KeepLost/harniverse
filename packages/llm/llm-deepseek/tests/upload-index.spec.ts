import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId, DeepSeekFileScope } from '../src/file-id.ts'
import { DeepSeekUploadIndex, deepSeekFileScope } from '../src/upload-index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function record(fileId = 'file-1') {
  return {
    scope: DeepSeekFileScope('a'.repeat(64)),
    attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
    variantId: ImageVariantId(`sha256:${'c'.repeat(64)}`),
    fileId: DeepSeekFileId(fileId),
    bytes: 12,
    createdAt: 1_000,
    expiresAt: 10_000,
  }
}

describe('DeepSeek upload index', () => {
  it('scopes records by normalized endpoint and API key without exposing the key', () => {
    expect(deepSeekFileScope('https://example.test///', 'key-a'))
      .not.toBe(deepSeekFileScope('https://example.test', 'key-b'))
    expect(deepSeekFileScope('https://example.test///', 'key-a'))
      .toMatch(/^[0-9a-f]{64}$/u)
  })

  it('commits, reuses, expires, and removes one mapping atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'llm-deepseek', 'files-v1.json'))
    const candidate = record()

    await expect(index.get(candidate.scope, candidate.variantId, 2_000, 1_000)).resolves.toBeUndefined()
    await expect(index.commit(candidate, 2_000, 1_000)).resolves.toEqual({ record: candidate, accepted: true })
    await expect(index.get(candidate.scope, candidate.variantId, 2_000, 1_000)).resolves.toEqual(candidate)
    await expect(index.get(candidate.scope, candidate.variantId, 9_500, 1_000)).resolves.toBeUndefined()
    await expect(index.commit({ ...candidate, fileId: DeepSeekFileId('file-2') }, 2_000, 1_000))
      .resolves.toEqual({ record: candidate, accepted: false })
    await index.remove(candidate.scope, candidate.variantId, candidate.fileId)
    await expect(index.get(candidate.scope, candidate.variantId, 2_000, 1_000)).resolves.toBeUndefined()
    await index.remove(candidate.scope, candidate.variantId, candidate.fileId)
    await index.clear(DeepSeekFileScope('f'.repeat(64)))
  })

  it('treats malformed or stale index contents as empty and rewrites a valid file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const path = join(root, 'files-v1.json')
    await writeFile(path, '{not-json')
    const index = new DeepSeekUploadIndex(path)
    const candidate = record()
    await expect(index.commit(candidate, 2_000, 1_000)).resolves.toEqual({ record: candidate, accepted: true })
    const saved = JSON.parse(await readFile(path, 'utf8')) as { formatVersion: number; records: unknown[] }
    expect(saved.formatVersion).toBe(1)
    expect(saved.records).toHaveLength(1)
  })

  it('deduplicates concurrent commits under the file lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'files-v1.json'))
    const results = await Promise.all([
      index.commit(record('file-a'), 2_000, 1_000),
      index.commit(record('file-b'), 2_000, 1_000),
    ])
    expect(results.filter(result => result.accepted)).toHaveLength(1)
    expect(results[0]?.record.variantId).toBe(results[1]?.record.variantId)
  })

  it('prunes expired mappings of other variants when it commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const path = join(root, 'files-v1.json')
    const stale = {
      ...record('file-stale'),
      variantId: ImageVariantId(`sha256:${'d'.repeat(64)}`),
      expiresAt: 3_000,
    }
    const live = {
      ...record('file-live'),
      variantId: ImageVariantId(`sha256:${'e'.repeat(64)}`),
      expiresAt: 90_000,
    }
    await writeFile(path, JSON.stringify({ formatVersion: 1, records: [stale, live] }))
    const index = new DeepSeekUploadIndex(path)
    const candidate = record('file-new')

    await expect(index.commit(candidate, 20_000, 1_000)).resolves.toEqual({ record: candidate, accepted: true })
    const saved = JSON.parse(await readFile(path, 'utf8')) as { records: { fileId: string }[] }
    // The expired mapping is dropped; the still-usable one survives.
    expect(saved.records.map(entry => entry.fileId).sort()).toEqual(['file-live', 'file-new'])
  })

  it('replaces its own expired mapping for the same variant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const path = join(root, 'files-v1.json')
    await writeFile(path, JSON.stringify({ formatVersion: 1, records: [record('file-old')] }))
    const index = new DeepSeekUploadIndex(path)
    const candidate = { ...record('file-fresh'), expiresAt: 90_000 }

    await expect(index.commit(candidate, 20_000, 1_000)).resolves.toEqual({ record: candidate, accepted: true })
    const saved = JSON.parse(await readFile(path, 'utf8')) as { records: { fileId: string }[] }
    expect(saved.records.map(entry => entry.fileId)).toEqual(['file-fresh'])
  })

  it('clears only the requested scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const path = join(root, 'files-v1.json')
    const other = { ...record('file-other'), scope: DeepSeekFileScope('b'.repeat(64)) }
    await writeFile(path, JSON.stringify({ formatVersion: 1, records: [record('file-mine'), other] }))
    const index = new DeepSeekUploadIndex(path)

    await index.clear(record().scope)
    const saved = JSON.parse(await readFile(path, 'utf8')) as { records: { fileId: string }[] }
    expect(saved.records.map(entry => entry.fileId)).toEqual(['file-other'])
  })

  it('propagates a read failure that is not a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    // A directory where the index belongs makes the read fail with EISDIR,
    // which is a real fault rather than an absent or unusable index.
    const path = join(root, 'files-v1.json')
    await mkdir(path, { recursive: true })
    const index = new DeepSeekUploadIndex(path)
    const candidate = record()

    await expect(index.get(candidate.scope, candidate.variantId, 2_000, 1_000)).rejects.toThrow()
  })

  it('treats unsupported, invalid, and duplicate records as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(root)
    const path = join(root, 'files-v1.json')
    const candidate = record()
    for (const contents of [
      JSON.stringify(null),
      JSON.stringify({ formatVersion: 2, records: [] }),
      JSON.stringify({ formatVersion: 1, records: [{}] }),
      JSON.stringify({ formatVersion: 1, records: [null] }),
      JSON.stringify({ formatVersion: 1, records: [[]] }),
      JSON.stringify({ formatVersion: 1, records: [candidate, candidate] }),
    ]) {
      await writeFile(path, contents)
      const index = new DeepSeekUploadIndex(path)
      await expect(index.get(candidate.scope, candidate.variantId, 2_000, 1_000)).resolves.toBeUndefined()
    }
  })
})
