/** End-to-end import of one in-memory export ZIP through the settle entry, plus the upload route's NDJSON framing. */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionImport from '@deepseek-ai/dsh-session-import'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { importDeepseekChatExport } from '../src/importer.ts'
import type { DeepseekChatImportDependencies, DeepseekChatImportLimits, DeepseekChatImportWorkspace } from '../src/importer.ts'
import { createUploadRoute } from '../src/upload.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()
const LIMITS: DeepseekChatImportLimits = { maxSessions: 1000, maxEntryBytes: 64 * 1024, maxTitleBytes: 80 }

let root = ''
let ctx: Context

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-deepseek-chat-import-')))
  ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') }).await()
  await ctx.plugin(SessionImport).await()
})

afterAll(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function deps(): DeepseekChatImportDependencies {
  return {
    sessionImport: ctx.sessionImport,
    workspaceRegistered: id => id === 'ws-1',
    createId: () => crypto.randomUUID(),
    warn: () => undefined,
  }
}

function workspace(): DeepseekChatImportWorkspace & { attached: SessionId[] } {
  const attached: SessionId[] = []
  return {
    id: 'ws-1',
    path: root,
    async attachSession(id) { attached.push(id) },
    attached,
  }
}

function exportZip(conversations: Record<string, unknown>, index: unknown[]): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify(index)),
    ...Object.fromEntries(Object.entries(conversations).map(([id, file]) => [`chat_sessions/${id}.json`, strToU8(JSON.stringify(file))])),
  })
}

function conversation(id: string, title: string | null, userText: string, replyText: string) {
  return {
    id,
    title,
    current_message_id: 2,
    inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(0), fragments: [{ type: 'REQUEST', content: userText }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(1_000), fragments: [{ type: 'RESPONSE', content: replyText }] },
    ],
  }
}

describe('importDeepseekChatExport', () => {
  it('settles every chosen conversation through the session-import entry, newest first', async () => {
    const target = workspace()
    const archive = exportZip({
      older: conversation('older', 'Older chat', 'hi', 'hello'),
      newer: conversation('newer', null, 'yo', 'hey'),
    }, [
      { id: 'older', inserted_at: at(0), updated_at: at(1_000) },
      { id: 'newer', inserted_at: at(0), updated_at: at(5_000) },
    ])

    const progress: Array<[number, number]> = []
    const result = await importDeepseekChatExport(deps(), {
      archive, workspace: target, limits: LIMITS,
      onProgress: (done, total) => { progress.push([done, total]) },
    }, new AbortController().signal)

    expect(result.workspaceId).toBe('ws-1')
    expect(result.conversationCount).toBe(2)
    expect(result.omittedByLimit).toBe(0)
    expect(result.skipped).toEqual([])
    expect(result.sessionIds).toHaveLength(2)
    // Newest by index order first.
    expect(progress[0]).toEqual([0, 2])
    expect(progress.at(-1)).toEqual([2, 2])
    expect([...target.attached].sort()).toEqual([...result.sessionIds].sort())

    for (const id of result.sessionIds) {
      const handle = await ctx.sessionPersistence.load(id as SessionId)
      expect(handle?.meta.cwd).toBe(root)
      const events = handle?.events ?? []
      expect(events[0]?.type).toBe('import/record')
      expect((events[0]?.data as { source: { format: string } }).source.format).toBe('deepseek-chat-v3')
      expect(events.some(event => event.type === 'user/message')).toBe(true)
      expect(events.some(event => event.type === 'assistant/message')).toBe(true)
    }
    // Re-importing the same archive reports each conversation as already imported.
    const again = await importDeepseekChatExport(deps(), {
      archive, workspace: workspace(), limits: LIMITS, onProgress: () => undefined,
    }, new AbortController().signal)
    expect(again.sessionIds).toEqual([])
    expect(again.skipped).toHaveLength(2)
    expect(again.skipped.every(skip => /already imported as session/.test(skip.reason))).toBe(true)
  })

  it('refuses an archive whose manifest names an unsupported version before writing anything', async () => {
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 2 })),
      'chat_session_index.json': strToU8('[]'),
    })
    await expect(importDeepseekChatExport(deps(), {
      archive, workspace: workspace(), limits: LIMITS, onProgress: () => undefined,
    }, new AbortController().signal)).rejects.toMatchObject({ reason: 'unsupported-version' })
  })
})

describe('upload route', () => {
  it('answers NDJSON progress lines and exactly one outcome line', async () => {
    const archive = exportZip({ only: conversation('only', 'One', 'q', 'a') }, [
      { id: 'only', inserted_at: at(0), updated_at: at(1) },
    ])
    const route = createUploadRoute({
      maxUploadBytes: 1024 * 1024,
      claim: () => {
        const controller = new AbortController()
        return {
          signal: controller.signal,
          release: () => {
            controller.abort()
          },
        }
      },
      workspace: () => workspace(),
      import: async (_archive, _workspace, onProgress, signal) => importDeepseekChatExport(deps(), {
        archive: _archive, workspace: _workspace, limits: LIMITS, onProgress,
      }, signal),
      failed: () => undefined,
    })

    const response = await route(new Request('https://host/api/deepseek-chat-import/archive?workspaceId=ws-1', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(archive),
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as { type: string })
    const outcome = lines.at(-1)
    expect(outcome).toMatchObject({ type: 'outcome', outcome: { ok: true } })
    expect(lines.some(line => line.type === 'progress')).toBe(true)
  })

  it('refuses a non-octet-stream media type and a missing workspace query', async () => {
    const route = createUploadRoute({
      maxUploadBytes: 1024,
      claim: () => undefined,
      workspace: () => undefined,
      import: () => { throw new Error('unreachable') },
      failed: () => undefined,
    })
    const wrongType = await route(new Request('https://host/x?workspaceId=w', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }))
    expect(wrongType.status).toBe(415)
    const missingQuery = await route(new Request('https://host/x', { method: 'POST', body: 'x', headers: { 'content-type': 'application/octet-stream' } }))
    expect(missingQuery.status).toBe(400)
  })
})
