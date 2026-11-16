/** Service registration, limits Remote, upload slot arbitration, and unload cancellation. */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import DeepseekChatImportService from '../src/index.ts'
import { UPLOAD_PATH } from '../src/index.ts'
import type { DeepseekChatImportLine } from '../src/index.ts'
import type { DeepseekChatImportWorkspace } from '../src/importer.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()

let root = ''
beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-deepseek-import-service-'))) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

function indexRow(id: string, updated: number): { id: string; inserted_at: string; updated_at: string } {
  return { id, inserted_at: at(0), updated_at: at(updated) }
}

/** A two-message conversation whose reply is stamped `leafAt` ms after BASE. */
function chat(id: string, leafAt: number) {
  return {
    id, title: `title ${id}`, inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(leafAt - 10), fragments: [{ type: 'REQUEST',
        content: `question ${id}` }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(leafAt), fragments: [
        { type: 'TOOL_SEARCH', queries: [`about ${id}`], results: [] },
        { type: 'RESPONSE', content: `answer ${id}` },
      ] },
    ],
  }
}

function archiveOf(id: string): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify([indexRow(id, 1_000)])),
    [`chat_sessions/${id}.json`]: strToU8(JSON.stringify(chat(id, 1_000))),
  })
}

/** The registry Workspace the importer settles into. */
function workspaceOf(path: string): DeepseekChatImportWorkspace {
  return { id: 'w1', path, attachSession: async () => undefined }
}

interface Fixture {
  ctx: Context
  workspace: DeepseekChatImportWorkspace
  attached: string[]
  settled: string[]
  dispose: () => Promise<void>
  warnings: string[]
  errors: unknown[][]
}

/** Context with the injected services recorded and a settle entry that can be held back. */
async function fixture(
  hold?: (ctx: Context, holdOne: (id: string, promise: Promise<{ sessionId: SessionId }>) => void) => void,
  fail: readonly string[] = [],
  registryGet?: (id: string) => DeepseekChatImportWorkspace | undefined,
): Promise<Fixture> {
  const ctx = new Context()
  const warnings: string[] = []
  const errors: unknown[][] = []
  const attached: string[] = []
  const settled: string[] = []
  const held = new Map<string, Promise<{ sessionId: SessionId }>>()
  const workspace: DeepseekChatImportWorkspace = {
    id: 'w1', path: root, attachSession: async (id) => { attached.push(id) },
  }
  ctx.provide('sessionImport', {
    async settleConverted(request: { sourceSessionId: string; title?: string }) {
      if (fail.includes(request.sourceSessionId)) throw new Error(`settle refused ${request.sourceSessionId}`)
      settled.push(request.sourceSessionId)
      const wait = held.get(request.sourceSessionId)
      return wait ?? Promise.resolve({ sessionId: SessionId(`imported-${request.sourceSessionId}`) })
    },
  } as never)
  ctx.provide('workspaceRegistry', { get: registryGet ?? ((id: string) => (id === 'w1' ? workspace : undefined)) } as never)
  hold?.(ctx, (id, promise) => { held.set(id, promise) })
  const fiber = await ctx.plugin(DeepseekChatImportService)
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: string) => { warnings.push(message) })
  vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
  return { ctx, workspace, attached, settled, dispose: () => fiber.dispose(), warnings, errors }
}

async function lines(response: Response): Promise<DeepseekChatImportLine[]> {
  const text = await response.text()
  return text.trim().split('\n').map(line => JSON.parse(line) as DeepseekChatImportLine)
}

function upload(archive: Uint8Array, workspaceId = 'w1'): Request {
  return new Request(`http://host.test${UPLOAD_PATH}?workspaceId=${workspaceId}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(archive),
  })
}

describe('DeepseekChatImportService', () => {
  it('registers ctx.deepseekChatImport, reports limits, and leaves with its fiber', async () => {
    const { ctx, dispose } = await fixture()
    const service = ctx.get('deepseekChatImport')
    expect(service).toBeInstanceOf(DeepseekChatImportService)
    expect(service!.limits()).toEqual({ maxUploadBytes: 512 * 1024 * 1024 })
    await dispose()
    expect(ctx.get('deepseekChatImport')).toBeUndefined()
  })

  it('serves one upload through the wired importer and attaches the settled Session', async () => {
    const { ctx, dispose, attached } = await fixture()
    const service = ctx.get('deepseekChatImport')!
    const response = await service.uploadRoute(upload(archiveOf('c1')))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
    const received = await lines(response)
    expect(received.slice(0, -1)).toEqual([{ type: 'progress', done: 0, total: 1 }, { type: 'progress', done: 1, total: 1 }])
    expect(received.at(-1)).toMatchObject({
      type: 'outcome',
      outcome: { ok: true, value: { workspaceId: 'w1', workspacePath: root, conversationCount: 1, omittedByLimit: 0, skipped: [] } },
    })
    const outcome = received.at(-1)!
    expect(outcome.type === 'outcome' && outcome.outcome.ok && outcome.outcome.value.sessionIds).toEqual(['imported-c1'])
    expect(attached).toEqual(['imported-c1'])
    await dispose()
  })

  it('holds the single import slot while an upload is running', async () => {
    let releaseSettle: (() => void) | undefined
    const { ctx, dispose } = await fixture((_ctx, holdOne) => {
      holdOne('c1', new Promise((resolve) => { releaseSettle = () => { resolve({ sessionId: SessionId('imported-c1') }) } }))
    })
    const service = ctx.get('deepseekChatImport')!
    const first = service.uploadRoute(upload(archiveOf('c1')))
    const busy = await service.uploadRoute(upload(archiveOf('c2')))
    const busyLines = await lines(busy)
    expect(busyLines).toEqual([{
      type: 'outcome', outcome: { ok: false, error: { reason: 'busy', message: 'another import is running' } },
    }])
    releaseSettle!()
    const firstLines = await lines(await first)
    expect(firstLines.at(-1)).toMatchObject({ type: 'outcome', outcome: { ok: true } })
    // The slot is free again once the running import settled.
    const again = await lines(await service.uploadRoute(upload(archiveOf('c2'))))
    const againOutcome = again.at(-1)!
    expect(againOutcome).toMatchObject({ type: 'outcome', outcome: { ok: true } })
    expect(againOutcome.type === 'outcome' && againOutcome.outcome.ok && againOutcome.outcome.value.sessionIds)
      .toEqual(['imported-c2'])
    await dispose()
  })

  it('answers an unknown workspace without touching the import slot', async () => {
    const { ctx, dispose } = await fixture()
    const service = ctx.get('deepseekChatImport')!
    const response = await service.uploadRoute(upload(archiveOf('c1'), 'missing'))
    expect(await lines(response)).toEqual([{
      type: 'outcome',
      outcome: { ok: false, error: { reason: 'workspace-not-found', message: 'workspace missing does not exist' } },
    }])
    // The failed claim was released, so a valid upload still runs.
    const valid = await service.uploadRoute(upload(archiveOf('c1')))
    expect((await lines(valid)).at(-1)).toMatchObject({ type: 'outcome', outcome: { ok: true } })
    await dispose()
  })

  it('fails the response body and logs when the import throws an unexpected error', async () => {
    // The route resolves the Workspace once; the import's next registry read withdraws it.
    let reads = 0
    const withdraw = (): DeepseekChatImportWorkspace | undefined => {
      reads += 1
      if (reads >= 3) throw new TypeError('registry withdrawn')
      return workspaceOf(root)
    }
    const { ctx, dispose, errors } = await fixture(undefined, [], withdraw)
    const response = await ctx.get('deepseekChatImport')!.uploadRoute(upload(archiveOf('c1')))
    await expect(new Response(response.body).text()).rejects.toThrow('registry withdrawn')
    expect(errors).toHaveLength(1)
    await dispose()
  })

  it('warns through the service logger for a conversation the export does not carry', async () => {
    const { ctx, dispose, warnings } = await fixture()
    const archive: Uint8Array = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_session_index.json': strToU8(JSON.stringify([indexRow('c1', 1_000), indexRow('ghost', 5_000)])),
      'chat_sessions/c1.json': strToU8(JSON.stringify(chat('c1', 1_000))),
    })
    const received = await lines(await ctx.get('deepseekChatImport')!.uploadRoute(upload(archive)))
    const outcome = received.at(-1)!
    expect(outcome).toMatchObject({ type: 'outcome', outcome: { ok: true } })
    expect(outcome.type === 'outcome' && outcome.outcome.ok && outcome.outcome.value.skipped).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ghost')
    await dispose()
  })

  it('cancels the running import on unload and waits for it to settle', async () => {
    let finishSecond: (() => void) | undefined
    const { ctx, dispose, settled } = await fixture((_ctx, holdOne) => {
      holdOne('c2', new Promise((resolve) => { finishSecond = () => { resolve({ sessionId: SessionId('imported-c2') }) } }))
    })
    const service = ctx.get('deepseekChatImport')!
    const archive: Uint8Array = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_session_index.json': strToU8(JSON.stringify([indexRow('c1', 1_000), indexRow('c2', 5_000)])),
      'chat_sessions/c1.json': strToU8(JSON.stringify(chat('c1', 1_000))),
      'chat_sessions/c2.json': strToU8(JSON.stringify(chat('c2', 5_000))),
    })
    const response = await service.uploadRoute(upload(archive))
    // Both conversations reach the settle entry; the second one is held back.
    await vi.waitFor(() => { expect(settled).toEqual(['c1', 'c2']) })
    const body = response.body!.tee()[1]
    // Unloading aborts the claim's signal and waits for the running import.
    const disposed = dispose()
    finishSecond!()
    await disposed
    // Unload aborted the claim, so the response ends without an outcome line.
    const received: DeepseekChatImportLine[] = (await new Response(body).text()).trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as DeepseekChatImportLine)
    expect(received.some(line => line.type === 'outcome')).toBe(false)
  })
})
