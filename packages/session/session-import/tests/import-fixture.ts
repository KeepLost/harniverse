import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionImport from '../src/importer.ts'

function foreignLine(type: string, data: unknown, time = 10): string {
  return JSON.stringify({ seq: 0, type, time, data })
}

export const FOREIGN_TEXT = [
  JSON.stringify({ version: 3, id: 'foreign-1', createdAt: 1000, cwd: '/foreign/home' }),
  foreignLine('turn/start', { turn: 1 }),
  foreignLine('user/message', {
    id: 'foreign-msg-1',
    role: 'user',
    content: [{ type: 'text', text: 'Summarize the repo.' }],
    source: { kind: 'user' },
  }),
  foreignLine('step/start', { turn: 1, step: 1 }),
  foreignLine('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'foreign-msg-2',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the tree first.' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
  foreignLine('tool/call', { turn: 1, step: 1, callId: 'call-7', name: 'list_dir', arguments: '{"path":"."}' }),
  foreignLine('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'foreign-msg-3',
      role: 'user',
      callId: 'call-7',
      content: [{ type: 'tool-result', toolCallId: 'call-7', content: [{ type: 'text', text: 'src/' }] }],
      isError: false,
      source: { kind: 'tool' },
    },
  }),
  foreignLine('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  foreignLine('request/header', { header: {}, reason: 'initial' }),
].join('\n')

export interface ImportFixture {
  readonly ctx: Context
  readonly root: string
  readonly artifactPath: string
  readonly foreignText: string
  readonly importer: SessionImport
  readonly persistence: SessionPersistence
  sessionId(name: string): SessionId
  join(relative: string): string
  importWithVersion(version: number, fileName: string): Promise<unknown>
  readArtifact(sessionId: SessionId, artifactName: string): Promise<string>
  loadedSession(sessionId: SessionId): Promise<Session>
  dispose(): Promise<void>
}

export async function createContextFixture(options?: { locateUndefined?: boolean }): Promise<ImportFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  const artifactPath = join(root, 'foreign-export.jsonl')
  await writeFile(artifactPath, FOREIGN_TEXT, 'utf8')

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  let persistence: SessionPersistence
  if (options?.locateUndefined === true) {
    persistence = { locate: () => undefined } as unknown as SessionPersistence
    ctx.provide('sessionPersistence', persistence)
  } else {
    await ctx.plugin(JsonlSessionPersistence, { root })
    persistence = ctx.get('sessionPersistence') as SessionPersistence
  }
  await ctx.plugin(SessionImport)
  const importer = ctx.get('sessionImport') as SessionImport

  return {
    ctx,
    root,
    artifactPath,
    foreignText: FOREIGN_TEXT,
    importer,
    persistence,
    sessionId: name => SessionId(name),
    join: relative => join(root, relative),
    importWithVersion: (version, fileName) => {
      const path = join(root, fileName)
      const text = `${JSON.stringify({ version })}\n${foreignLine('turn/start', { turn: 1 })}\n`
      return writeFile(path, text, 'utf8').then(() => importer.import({ artifactPath: path }))
    },
    readArtifact: (sessionId, artifactName) => {
      const location = persistence.locate({ version: 0, id: sessionId, createdAt: 1, cwd: '/foreign/home' })
      if (location === undefined) return Promise.reject(new Error('no location'))
      return readFile(join(dirname(location.path), artifactName), 'utf8')
    },
    async loadedSession(sessionId) {
      const preparation = await persistence.prepare(sessionId)
      try {
        return preparation.session
      } finally {
        preparation[Symbol.dispose]()
      }
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
