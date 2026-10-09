// Proves the import Remote is real Loader composition: a cordis.yml booting the
// real session, JSONL persistence, archival importer, storage/domain/workspace
// stack, and this service scans an official root, imports into the workspace
// at the source cwd, and publishes the archive to the workspace and to carriers.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionImport from '@deepseek-ai/dsh-session-import'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import OfficialSessionImport from '../src/index.ts'
import { officialArtifact, tempRoot, withHeader, writeOfficialLog, zstdLog } from './official-fixture.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(base: string): Promise<Context> {
  const configPath = join(base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(base, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(base, 'sessions'))}`,
    "- name: '@deepseek-ai/dsh-session-import'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-host-official-session-import'",
    '  config:',
    '    roots:',
    `      - ${JSON.stringify(join(base, 'official'))}`,
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(base).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-persistence-jsonl', SessionPersistenceJsonl],
    ['@deepseek-ai/dsh-session-import', SessionImport],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@deepseek-ai/dsh-host-official-session-import', OfficialSessionImport],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('official-session-import loader composition', () => {
  it('scans an official root and imports into the registered workspace at the source cwd', async () => {
    root = await tempRoot('dsh-official-loader-')
    const sourceCwd = join(root, 'project')
    await mkdir(sourceCwd)
    await writeOfficialLog(join(root, 'official'), '--project--', 'session-official', 'session.v4.jsonl.zstd',
      zstdLog(withHeader(await officialArtifact(4), { cwd: sourceCwd })))
    const ctx = await boot(root)
    const announced: SessionHeader[] = []
    ctx.on('session/imported', (header) => { announced.push(header) })
    const service = ctx.get('officialSessionImport') as OfficialSessionImport

    const scan = await service.scan()
    expect(scan.items).toEqual([expect.objectContaining({ status: 'new', sourceCwd, title: 'Use the bash tool to' })])
    const [result] = await service.importSources([scan.items[0]!.sourceId], { kind: 'source-cwd' })
    expect(result?.outcome).toMatchObject({ status: 'imported', attached: true })
    const sessionId = (result!.outcome as { sessionId: string }).sessionId

    const [workspace] = ctx.workspaceRegistry.list()
    expect(workspace?.path).toBe(sourceCwd)
    expect(workspace?.sessionIds).toEqual([sessionId])
    expect(announced.map(header => header.id)).toEqual([sessionId])
    const inspected = await ctx.sessionPersistence.inspect(sessionId as never)
    const archive = Session.create(inspected.meta.id, inspected.events, inspected.meta)
    expect(archive.eventAt(0)?.type).toBe('import/record')
    expect(JSON.stringify(archive.deriveMessages())).toContain('TERMINAL_OK')
    expect((await service.scan()).items[0]).toMatchObject({ status: 'imported', archiveSessionId: sessionId })
  }, 30_000)
})
