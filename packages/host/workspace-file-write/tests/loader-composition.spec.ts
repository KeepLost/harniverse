// Proves the editing Remote is real Loader composition, not unit wiring: a
// cordis.yml booting the real storage/domain/workspace/agent stack plus
// dsh-fs-local serves an editable open, a version-checked save through the
// same per-target lock the Agent tools use, a durable byte-exact write-back,
// and the non-waking Agent notice over the real agent inbox.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkspaceFileWriteService from '@deepseek-ai/dsh-workspace-file-write'
import { SOURCE_ID, noticeText } from '../src/index.ts'
import type { UserMessage } from '@deepseek-ai/dsh-session'

interface RemoteErrorLike {
  code: string
  message: string
  details: { currentVersion?: string }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the real composition from a generated cordis.yml. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-workspace-file-write-loader-'))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'notes.md'), '# one\n\nfirst\n', 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-workspace-file-write'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-persistence-jsonl', SessionPersistenceJsonl],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-workspace-file-write', WorkspaceFileWriteService],
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

describe('workspace-file-write loader composition', () => {
  it('serves an editable save over the real registry, fs backend, and agent inbox', async () => {
    const ctx = await boot()
    const project = join(root as string, 'project')
    const workspace = await ctx.workspaceRegistry.create(project)
    expect(workspace.path).toBe(project)

    const notices: UserMessage[] = []
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'plugin' && message.source.plugin === SOURCE_ID) notices.push(message)
    })
    await ctx.agents.create({
      sessionId: SessionId('loader-edit'),
      meta: { cwd: project },
    })

    const signal = (): AbortSignal => new AbortController().signal
    const opened = await ctx.workspaceFileWrite.open(workspace.id, 'notes.md', signal())
    expect(opened.content).toBe('# one\n\nfirst\n')
    expect(opened.eol).toBe('LF')

    const saved = await ctx.workspaceFileWrite.save(workspace.id, 'notes.md', {
      content: '# one\n\nsecond\n', baseVersion: opened.version, saveId: 'loader-save-1',
    }, signal())
    expect(saved.version).not.toBe(opened.version)
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# one\n\nsecond\n')

    // A second save against the stale premise refuses with the current version.
    const stale = await ctx.workspaceFileWrite.save(workspace.id, 'notes.md', {
      content: '# stale\n', baseVersion: opened.version, saveId: 'loader-save-2',
    }, signal()).then(() => { throw new Error('expected refusal') }, (error: unknown) => error as RemoteErrorLike)
    expect(stale.code).toBe('stale-version')
    expect(stale.details).toMatchObject({ currentVersion: saved.version })

    // The committed save injected exactly one path-only notice into the
    // workspace's live session (verifiable model-visible output).
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    expect(notices[0]?.content[0]).toMatchObject({ type: 'text', text: noticeText('notes.md') })
    expect(notices[0]?.source).toMatchObject({ kind: 'plugin', form: 'system-injection', path: 'notes.md' })
  })
})
