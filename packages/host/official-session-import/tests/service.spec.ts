import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionImport, { ForeignLogError } from '@deepseek-ai/dsh-session-import'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import OfficialSessionImport, { DEFAULT_MAX_ARTIFACT_BYTES, type Config } from '../src/index.ts'
import type { OfficialImportResult } from '../src/types.ts'
import { FOREIGN_TEXT, officialArtifact, tempRoot, withHeader, writeOfficialLog, zstdLog } from './official-fixture.ts'

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly official: string
  readonly sessions: string
  readonly service: OfficialSessionImport
  readonly importer: SessionImport
  readonly workspaces: Workspace[]
  readonly attach: ReturnType<typeof vi.fn<(id: SessionId) => Promise<void>>>
  workspace(path: string): Workspace
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.ctx.fiber.dispose()
    await rm(harness.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function harness(config: { maxArtifactBytes?: number } = {}): Promise<Harness> {
  const root = await tempRoot('dsh-official-service-')
  const official = join(root, 'official')
  const sessions = join(root, 'sessions')
  await mkdir(official)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  await ctx.plugin(SessionImport)
  const workspaces: Workspace[] = []
  const attach = vi.fn<(id: SessionId) => Promise<void>>(() => Promise.resolve())
  const workspace = (path: string): Workspace => {
    const created = { id: WorkspaceId(`workspace-${String(workspaces.length + 1)}`), path, attachSession: attach } as unknown as Workspace
    workspaces.push(created)
    return created
  }
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaces.find(candidate => candidate.id === id),
    create: async (path: string) => {
      if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a directory`)
      return workspaces.find(candidate => candidate.path === path) ?? workspace(path)
    },
  } as never)
  // The schema supplies the default limit when a spec leaves it out.
  await ctx.plugin(OfficialSessionImport, { roots: [official], ...config } as Config)
  const created: Harness = {
    ctx, root, official, sessions, workspaces, attach, workspace,
    service: ctx.get('officialSessionImport') as OfficialSessionImport,
    importer: ctx.get('sessionImport') as SessionImport,
  }
  harnesses.push(created)
  return created
}

function outcome(results: readonly OfficialImportResult[]): OfficialImportResult['outcome'][] {
  return results.map(result => result.outcome)
}

describe('official session scan', () => {
  it('describes newest generations, reports unusable logs, and sorts by recency', async () => {
    const h = await harness({ maxArtifactBytes: 64 * 1024 })
    await writeOfficialLog(h.official, '--home-a--', 's1', 'session.v4.jsonl.zstd', zstdLog(await officialArtifact(4)))
    await writeOfficialLog(h.official, '--home-a--', 's2', 'session.v3.jsonl', FOREIGN_TEXT)
    const bad = await writeOfficialLog(h.official, '--home-a--', 'bad', 'session.v4.jsonl', 'not a log')
    const big = await writeOfficialLog(h.official, '--home-a--', 'big', 'session.v2.jsonl', 'x'.repeat(64 * 1024 + 1))
    const scan = await h.service.scan()
    expect(scan.roots).toEqual([h.official])
    expect(scan.maxArtifactBytes).toBe(64 * 1024)
    expect(scan.items.map(item => [item.sourceId, item.status])).toEqual([
      ['0/--home-a--/s1/session.v4.jsonl.zstd', 'new'],
      ['0/--home-a--/s2/session.v3.jsonl', 'new'],
    ])
    expect(scan.items[0]).toMatchObject({ format: 'official-v4', title: 'Use the bash tool to', turns: 1 })
    expect(scan.items[0]).not.toHaveProperty('archiveSessionId')
    expect(scan.items[1]).toEqual({
      sourceId: '0/--home-a--/s2/session.v3.jsonl',
      path: join(h.official, '--home-a--', 's2', 'session.v3.jsonl'),
      format: 'official-v3',
      sourceSessionId: 'foreign-1',
      sourceCwd: '/foreign/home',
      preview: 'Summarize the repo.',
      turns: 1,
      createdAt: 1000,
      updatedAt: 1000,
      sizeBytes: Buffer.byteLength(FOREIGN_TEXT),
      status: 'new',
    })
    expect(scan.unreadable).toEqual([
      { path: bad, reason: 'invalid', message: expect.stringContaining('not valid JSON') as string },
      { path: big, reason: 'too-large', message: `${String(64 * 1024 + 1)} bytes exceeds the 65536-byte limit` },
    ])
  })

  it('tracks import status across imports and source growth, rereading only changed logs', async () => {
    const h = await harness()
    const project = join(h.root, 'project')
    await mkdir(project)
    const target = h.workspace(project)
    const log = await writeOfficialLog(h.official, '--p--', 's', 'session.v3.jsonl', FOREIGN_TEXT)
    const [first] = (await h.service.scan()).items
    const [imported] = outcome(await h.service.importSources([first!.sourceId], { kind: 'workspace', workspaceId: target.id }))
    expect(imported).toMatchObject({ status: 'imported', workspaceId: target.id, attached: true, mappedEvents: 8, skippedEvents: 1 })
    expect(imported).not.toHaveProperty('title')
    const describe = vi.spyOn(h.importer, 'describe')
    expect((await h.service.scan()).items[0]).toMatchObject({ status: 'imported', archiveSessionId: (imported as { sessionId: string }).sessionId })
    expect(describe).not.toHaveBeenCalled()
    await appendFile(log, '\n')
    expect((await h.service.scan()).items[0]).toMatchObject({ status: 'updated', archiveSessionId: (imported as { sessionId: string }).sessionId })
    expect(describe).toHaveBeenCalledOnce()
    await rm(log)
    expect((await h.service.scan()).items).toEqual([])
    await writeFile(log, FOREIGN_TEXT)
    expect((await h.service.scan()).items[0]).toMatchObject({ status: 'imported' })
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('omits absent provenance and orders equally recent candidates by source id', async () => {
    const h = await harness()
    const silent = FOREIGN_TEXT.split('\n').filter((_line, index) => index !== 2)
      .map((line, index) => index === 0 ? line : JSON.stringify({ ...JSON.parse(line) as object, seq: index - 1 })).join('\n')
    await writeOfficialLog(h.official, 'p', 'b', 'session.v3.jsonl', withHeader(silent, { id: 'foreign-b', cwd: undefined }))
    await writeOfficialLog(h.official, 'p', 'a', 'session.v3.jsonl', withHeader(silent, { id: 'foreign-a', cwd: undefined }))
    const { items } = await h.service.scan()
    expect(items.map(item => item.sourceId)).toEqual(['0/p/a/session.v3.jsonl', '0/p/b/session.v3.jsonl'])
    for (const item of items) {
      expect(item).not.toHaveProperty('sourceCwd')
      expect(item).not.toHaveProperty('preview')
      expect(item).not.toHaveProperty('title')
    }
  })

  it('reports unlistable roots and stops once aborted', async () => {
    const h = await harness()
    await rm(h.official, { recursive: true })
    await writeFile(h.official, 'not a directory')
    expect((await h.service.scan()).unreadable).toEqual([
      { path: h.official, reason: 'unreadable', message: expect.stringContaining('ENOTDIR') as string },
    ])
    await rm(h.official)
    await writeOfficialLog(h.official, 'p', 's', 'session.v3.jsonl', FOREIGN_TEXT)
    const abort = new AbortController()
    const scanning = h.service.scan(abort.signal)
    abort.abort(new Error('stop'))
    await expect(scanning).rejects.toThrow('stop')
  })

  it('reports a log that vanishes between listing and reading as unreadable', async () => {
    const h = await harness()
    const log = await writeOfficialLog(h.official, 'p', 's', 'session.v3.jsonl', FOREIGN_TEXT)
    vi.spyOn(h.importer, 'describe').mockImplementationOnce(() => { throw new Error('read raced a delete') })
    expect((await h.service.scan()).unreadable).toEqual([{ path: log, reason: 'unreadable', message: 'read raced a delete' }])
    vi.spyOn(h.importer, 'describe').mockImplementationOnce(() => { throw 'opaque' as unknown as Error })
    expect((await h.service.scan()).unreadable).toEqual([{ path: log, reason: 'unreadable', message: 'opaque' }])
  })
})

describe('official source import', () => {
  it('refuses unknown, missing, oversized, and invalid sources', async () => {
    const h = await harness({ maxArtifactBytes: 2048 })
    const target = { kind: 'workspace', workspaceId: h.workspace(h.root).id } as const
    await writeOfficialLog(h.official, 'p', 'big', 'session.v3.jsonl', 'x'.repeat(4096))
    await writeOfficialLog(h.official, 'p', 'bad', 'session.v3.jsonl', 'not a log')
    expect(outcome(await h.service.importSources([
      '0/../escape/session.v3.jsonl', '0/p/gone/session.v3.jsonl', '0/p/big/session.v3.jsonl', '0/p/bad/session.v3.jsonl',
    ], target))).toEqual([
      { status: 'failed', reason: 'source-missing', message: 'unknown source "0/../escape/session.v3.jsonl"' },
      { status: 'failed', reason: 'source-missing', message: expect.stringContaining('ENOENT') as string },
      { status: 'failed', reason: 'too-large', message: '4096 bytes exceeds the 2048-byte limit' },
      { status: 'failed', reason: 'invalid', message: expect.stringContaining('not valid JSON') as string },
    ])
  })

  it('lands in the workspace at the source cwd, registering it on demand', async () => {
    const h = await harness()
    const sourceCwd = join(h.root, 'official-project')
    await mkdir(sourceCwd)
    await writeOfficialLog(h.official, 'p', 's', 'session.v4.jsonl.zstd', zstdLog(withHeader(await officialArtifact(4), { cwd: sourceCwd })))
    const [item] = (await h.service.scan()).items
    const [result] = await h.service.importSources([item!.sourceId], { kind: 'source-cwd' })
    expect(result).toEqual({
      source: item!.sourceId,
      outcome: {
        status: 'imported', sessionId: expect.stringMatching(/^session-imported-/u) as string, workspaceId: h.workspaces[0]!.id,
        attached: true, title: 'Use the bash tool to', mappedEvents: expect.any(Number) as number, skippedEvents: expect.any(Number) as number,
      },
    })
    expect(h.workspaces.map(workspace => workspace.path)).toEqual([sourceCwd])
    expect(outcome(await h.service.importSources([item!.sourceId], { kind: 'source-cwd' })))
      .toEqual([{ status: 'already-imported', sessionId: (result!.outcome as { sessionId: string }).sessionId }])
  })

  it('reports unusable workspaces without importing', async () => {
    const h = await harness()
    await writeOfficialLog(h.official, 'p', 'no-cwd', 'session.v3.jsonl', withHeader(FOREIGN_TEXT, { cwd: undefined }))
    await writeOfficialLog(h.official, 'p', 'gone-cwd', 'session.v3.jsonl', withHeader(FOREIGN_TEXT, { id: 'foreign-2', cwd: join(h.root, 'missing') }))
    expect(outcome(await h.service.importSources(['0/p/no-cwd/session.v3.jsonl', '0/p/gone-cwd/session.v3.jsonl'], { kind: 'source-cwd' }))).toEqual([
      { status: 'failed', reason: 'workspace-unavailable', message: 'the official session recorded no working directory' },
      { status: 'failed', reason: 'workspace-unavailable', message: expect.stringMatching(/^cannot use ".*missing" as a workspace here: .*ENOENT/u) as string },
    ])
    expect(outcome(await h.service.importSources(['0/p/no-cwd/session.v3.jsonl'], { kind: 'workspace', workspaceId: WorkspaceId('nope') }))).toEqual([
      { status: 'failed', reason: 'workspace-unavailable', message: 'workspace "nope" not found' },
    ])
    expect(await h.ctx.sessionPersistence.list()).toEqual([])
  })

  it('keeps a settled archive that could not join its workspace, and maps importer failures', async () => {
    const h = await harness()
    const target = { kind: 'workspace', workspaceId: h.workspace(h.root).id } as const
    await writeOfficialLog(h.official, 'p', 's', 'session.v3.jsonl', FOREIGN_TEXT)
    h.attach.mockRejectedValueOnce(new Error('registry full'))
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    expect(outcome(await h.service.importSources(['0/p/s/session.v3.jsonl'], target))).toEqual([
      expect.objectContaining({ status: 'imported', attached: false }),
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not join its workspace: registry full'))
    await writeOfficialLog(h.official, 'p', 't', 'session.v3.jsonl', withHeader(FOREIGN_TEXT, { id: 'foreign-3' }))
    vi.spyOn(h.importer, 'import')
      .mockRejectedValueOnce(new ForeignLogError('late refusal'))
      .mockRejectedValueOnce(new Error('disk full'))
    expect(outcome(await h.service.importSources(['0/p/t/session.v3.jsonl', '0/p/t/session.v3.jsonl'], target))).toEqual([
      { status: 'failed', reason: 'invalid', message: 'late refusal' },
      { status: 'failed', reason: 'failed', message: 'disk full' },
    ])
  })

  it('stops between imports once aborted', async () => {
    const h = await harness()
    const abort = new AbortController()
    abort.abort(new Error('stop'))
    await expect(h.service.importSources(['0/p/s/session.v3.jsonl'], { kind: 'source-cwd' }, abort.signal)).rejects.toThrow('stop')
  })
})

describe('official upload import', () => {
  it('imports uploaded bytes under the bare file name', async () => {
    const h = await harness()
    const target = { kind: 'workspace', workspaceId: h.workspace(h.root).id } as const
    const result = await h.service.importUpload('../elsewhere/session.v4.jsonl.zstd', zstdLog(await officialArtifact(4)).toString('base64'), target)
    expect(result).toMatchObject({ source: 'session.v4.jsonl.zstd', outcome: { status: 'imported', title: 'Use the bash tool to' } })
    expect(await h.service.importUpload('x.jsonl', Buffer.from('nope').toString('base64'), target))
      .toMatchObject({ source: 'x.jsonl', outcome: { status: 'failed', reason: 'invalid' } })
  })

  it('refuses oversized uploads before and after decoding', async () => {
    const h = await harness({ maxArtifactBytes: 65536 })
    const target = { kind: 'source-cwd' } as const
    expect(await h.service.importUpload('a.jsonl', 'A'.repeat(87388), target))
      .toEqual({ source: 'a.jsonl', outcome: { status: 'failed', reason: 'too-large', message: '65541 bytes exceeds the 65536-byte limit' } })
    expect(await h.service.importUpload('b.jsonl', Buffer.alloc(65537).toString('base64'), target))
      .toEqual({ source: 'b.jsonl', outcome: { status: 'failed', reason: 'too-large', message: '65537 bytes exceeds the 65536-byte limit' } })
  })
})

describe('configuration', () => {
  it('defaults the artifact limit and refuses relative roots', async () => {
    const h = await harness()
    expect((await h.service.scan()).maxArtifactBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES)
    const ctx = new Context()
    ctx.provide('sessionImport', {} as never)
    ctx.provide('sessionPersistence', {} as never)
    ctx.provide('workspaceRegistry', {} as never)
    await expect(ctx.plugin(OfficialSessionImport, { roots: ['relative/sessions'] } as Config).await())
      .rejects.toThrow('official-session-import roots must be absolute, got "relative/sessions"')
    await ctx.fiber.dispose()
  })
})
