/** Import selection, budget, skip, image, and failure paths through a recording settle entry. */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ImportConflictError } from '@deepseek-ai/dsh-session-import'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { importDeepseekChatExport } from '../src/importer.ts'
import type { DeepseekChatImportDependencies, DeepseekChatImportLimits, DeepseekChatImportWorkspace } from '../src/importer.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()
const LIMITS: DeepseekChatImportLimits = { maxSessions: 1000, maxEntryBytes: 64 * 1024, maxTitleBytes: 80 }

let root = ''
let WORKSPACE_PATH = ''
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-deepseek-importer-')))
  WORKSPACE_PATH = root
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

interface Recorded {
  sourceSessionId: string
  title?: string
  cwd: string
}

/** A two-message conversation whose reply, the newest leaf, is stamped `leafAt` ms after BASE. */
function chat(id: string, leafAt: number, title: string | null = `title ${id}`, status = 'FINISHED') {
  return {
    id, title, inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(leafAt - 10), fragments: [{ type: 'REQUEST',
        content: `question ${id}` }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status, inserted_at: at(leafAt), fragments: [{ type: 'RESPONSE',
        content: `answer ${id}` }] },
    ],
  }
}

function zipOf(conversations: readonly unknown[], index: readonly { id: string; inserted_at: string; updated_at: string }[],
  extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify(index)),
    ...Object.fromEntries(conversations.map(file => [`chat_sessions/${(file as { id: string }).id}.json`, strToU8(JSON.stringify(file))])),
    ...extra,
  })
}

function indexRow(id: string, updated: number): { id: string; inserted_at: string; updated_at: string } {
  return { id, inserted_at: at(0), updated_at: at(updated) }
}

function deps(options: {
  conflict?: string[]
  fail?: string[]
  createId?: () => string
  attachments?: DeepseekChatImportDependencies['attachments']
}): { deps: DeepseekChatImportDependencies; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  let counter = 0
  const d: DeepseekChatImportDependencies = {
    sessionImport: {
      async settleConverted(request) {
        if (options.fail?.includes(request.sourceSessionId)) {
          throw new Error(`settle refused ${request.sourceSessionId}`)
        }
        if (options.conflict?.includes(request.sourceSessionId)) {
          throw new ImportConflictError(SessionId(`existing-${request.sourceSessionId}`))
        }
        recorded.push({ sourceSessionId: request.sourceSessionId, ...request.title === undefined ? {} : { title: request.title },
          cwd: request.cwd })
        return { sessionId: SessionId(`imported-${String(counter++)}`), ...(request.title === undefined ? {} : { title: request.title }) }
      },
    },
    workspaceRegistered: () => true,
    createId: options.createId ?? (() => `id-${String(counter++)}`),
    warn: () => undefined,
    ...options.attachments === undefined ? {} : { attachments: options.attachments },
  }
  return { deps: d, recorded }
}

function workspace(): DeepseekChatImportWorkspace & { attached: SessionId[] } {
  const attached: SessionId[] = []
  return { id: 'ws-1', path: WORKSPACE_PATH, async attachSession(id) { attached.push(id) }, attached }
}

async function run(d: DeepseekChatImportDependencies, archive: Uint8Array, limits: DeepseekChatImportLimits = LIMITS,
  onProgress: (done: number, total: number) => void = () => undefined) {
  const target = workspace()
  const result = await importDeepseekChatExport(d, { archive, workspace: target, limits, onProgress }, new AbortController().signal)
  return { result, target }
}

describe('importDeepseekChatExport', () => {
  it('imports the newest conversations first and settles each with its source facts', async () => {
    const { deps: d, recorded } = deps({})
    const archive = zipOf([chat('older', 1_000), chat('newer', 5_000)], [indexRow('older', 1_000), indexRow('newer', 5_000)])
    const { result } = await run(d, archive)
    // Settling follows archive entry order; the result reports the index's newest-first ranking.
    expect(recorded.map(entry => entry.sourceSessionId).sort()).toEqual(['newer', 'older'])
    expect(recorded.find(entry => entry.sourceSessionId === 'newer')).toMatchObject({ title: 'title newer', cwd: WORKSPACE_PATH })
    expect(result.skipped).toEqual([])
    expect(result.conversationCount).toBe(2)
  })

  it('caps the selection at maxSessions and reports the omission', async () => {
    const { deps: d } = deps({})
    const archive = zipOf([chat('a', 1), chat('b', 2), chat('c', 3)], [indexRow('a', 1), indexRow('b', 2), indexRow('c', 3)])
    const { result } = await run(d, archive, { ...LIMITS, maxSessions: 2 })
    expect(result.sessionIds).toHaveLength(2)
    expect(result.omittedByLimit).toBe(1)
  })

  it('replaces a conversation whose settle conflicts with the next older one', async () => {
    const { deps: d, recorded } = deps({ conflict: ['newest'] })
    const archive = zipOf([chat('newest', 9), chat('older', 5), chat('oldest', 1)], [indexRow('newest', 9), indexRow('older', 5),
      indexRow('oldest', 1)])
    const { result } = await run(d, archive)
    // The conflicting newest is retried, fails, then the next older conversations replace it.
    expect([...recorded.map(entry => entry.sourceSessionId)].sort()).toEqual(['older', 'oldest'])
    expect(result.sessionIds).toHaveLength(2)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.conversationId).toBe('newest')
    expect(result.skipped[0]?.reason).toContain('already imported')
  })

  it('reports a chosen conversation whose file the archive does not carry and replaces it', async () => {
    const { deps: d } = deps({})
    const index = [indexRow('missing', 5), indexRow('present', 1)]
    const archive = zipOf([chat('present', 1)], index)
    const { result } = await run(d, archive)
    expect(result.skipped[0]?.reason).toContain('no file for this conversation')
    expect(result.sessionIds).toHaveLength(1)
  })

  it('skips a damaged conversation entry and replaces it', async () => {
    const { deps: d } = deps({})
    const index = [indexRow('damaged', 5), indexRow('fine', 1)]
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_session_index.json': strToU8(JSON.stringify(index)),
      'chat_sessions/damaged.json': strToU8('{"id": '),
      'chat_sessions/fine.json': strToU8(JSON.stringify(chat('fine', 1))),
    })
    const { result } = await run(d, archive)
    expect(result.skipped[0]?.conversationId).toBe('damaged')
    expect(result.sessionIds).toHaveLength(1)
  })

  it('stores image entries of chosen conversations and blocks an unsupported image type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const saved: Array<{ name?: string }> = []
    const attachments: NonNullable<DeepseekChatImportDependencies['attachments']> = {
      async saveImage(input) {
        saved.push({ ...input.name === undefined ? {} : { name: input.name } })
        return { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: input.mediaType, bytes: input.data.byteLength } as ImageAttachmentRef
      },
    }
    const { deps: d, recorded } = deps({ attachments })
    const file = {
      id: 'c1', title: null, inserted_at: at(0),
      messages: [{
        id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(0),
        fragments: [{ type: 'FILE', files: [
          { id: 'f1', file_name: 'chart.png', file_size: 4, is_image: true,
            export_path: 'chat_sessions/c1_files/f81d4fae-7dec-11d0-a765-00a0c91e6bf6_chart.png' },
          { id: 'f2', file_name: 'raw.tiff', file_size: 8, is_image: true,
            export_path: 'chat_sessions/c1_files/f81d4fae-7dec-11d0-a765-00a0c91e6bf6_raw.tiff' },
        ] }],
      }],
    }
    const archive = zipOf([file], [indexRow('c1', 1)], {
      'chat_sessions/c1_files/f81d4fae-7dec-11d0-a765-00a0c91e6bf6_chart.png': png,
      'chat_sessions/c1_files/f81d4fae-7dec-11d0-a765-00a0c91e6bf6_raw.tiff': new Uint8Array(8),
    })
    const { result } = await run(d, archive)
    expect(result.sessionIds).toHaveLength(1)
    expect(saved).toEqual([{ name: 'chart.png' }])
    expect(recorded).toHaveLength(1)
  })

  it('refuses an unreadable archive before writing anything', async () => {
    const { deps: d } = deps({})
    await expect(run(d, strToU8('not a zip'))).rejects.toMatchObject({ reason: 'unreadable-archive' })
  })

  it.each([
    ['missing-manifest', (index: string) => zipSync({ 'chat_session_index.json': strToU8(index) })],
    ['missing-index', () => zipSync({ 'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })) })],
  ])('reports %s', async (reason, build) => {
    const { deps: d } = deps({})
    const archive = build(JSON.stringify([indexRow('x', 1)]))
    await expect(run(d, archive)).rejects.toMatchObject({ reason })
  })

  it('refuses an unsupported export version and an empty index', async () => {
    const { deps: d } = deps({})
    const versioned = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 2 })),
      'chat_session_index.json': strToU8('[]'),
    })
    await expect(run(d, versioned)).rejects.toMatchObject({ reason: 'unsupported-version' })
    const empty = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_session_index.json': strToU8('[]'),
    })
    await expect(run(d, empty)).rejects.toMatchObject({ reason: 'no-conversations' })
  })

  it('stops when the workspace disappears mid-import', async () => {
    let calls = 0
    const recorded: unknown[] = []
    const d: DeepseekChatImportDependencies = {
      sessionImport: { async settleConverted(request) { recorded.push(request); return { sessionId: SessionId(`s${String(calls++)}`) } } },
      workspaceRegistered: () => calls === 0,
      createId: () => 'x',
      warn: () => undefined,
    }
    const archive = zipOf([chat('a', 2), chat('b', 1)], [indexRow('a', 2), indexRow('b', 1)])
    await expect(importDeepseekChatExport(d, { archive, workspace: workspace(), limits: LIMITS, onProgress: () => undefined },
      new AbortController().signal))
      .rejects.toMatchObject({ reason: 'workspace-not-found' })
    expect(recorded).toHaveLength(1)
  })

  it('reports an unknown workspace before reading the archive body', async () => {
    const { deps: d } = deps({})
    const failing = vi.fn()
    void failing
    const archive = zipOf([chat('a', 1)], [indexRow('a', 1)])
    const target: DeepseekChatImportWorkspace = { id: 'ws-2', path: WORKSPACE_PATH, attachSession: () => Promise.resolve() }
    await expect(importDeepseekChatExport({ ...d, workspaceRegistered: () => false }, {
      archive, workspace: target, limits: LIMITS, onProgress: () => undefined,
    }, new AbortController().signal)).rejects.toMatchObject({ reason: 'workspace-not-found' })
  })

  it('reports progress for the selection and each settle', async () => {
    const { deps: d } = deps({})
    const archive = zipOf([chat('a', 2), chat('b', 1)], [indexRow('a', 2), indexRow('b', 1)])
    const progress: Array<[number, number]> = []
    await run(d, archive, LIMITS, (done, total) => { progress.push([done, total]) })
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]])
  })

  it('reports an oversized metadata entry as too-large before writing', async () => {
    const { deps: d } = deps({})
    const bigIndex = strToU8(JSON.stringify([indexRow('a', 1)]) + ' '.repeat(200))
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_session_index.json': [bigIndex, { level: 0 }],
      'chat_sessions/a.json': strToU8(JSON.stringify(chat('a', 1))),
    })
    await expect(run(d, archive, { ...LIMITS, maxEntryBytes: 64 })).rejects.toMatchObject({ reason: 'too-large' })
  })
})
