import { describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { importedSessionIdFor, importLineageOf } from '../src/contract.ts'
import { ForeignLogError } from '../src/foreign.ts'
import { ImportConflictError } from '../src/importer.ts'
import { createContextFixture, FOREIGN_TEXT, officialArtifact } from './import-fixture.ts'

/** Two independently decodable frames, as official builds write header and batches. */
function zstdFrames(text: string): Buffer {
  const split = text.indexOf('\n') + 1
  return Buffer.concat([zstdCompressSync(Buffer.from(text.slice(0, split))), zstdCompressSync(Buffer.from(text.slice(split)))])
}

describe('content-derived archive identity', () => {
  it('derives one id per exact text under a lineage shared by the same foreign session', () => {
    const first = importedSessionIdFor('foreign-1', FOREIGN_TEXT)
    expect(first).toBe(importedSessionIdFor('foreign-1', FOREIGN_TEXT))
    expect(first.startsWith(importLineageOf('foreign-1'))).toBe(true)
    const grown = importedSessionIdFor('foreign-1', `${FOREIGN_TEXT}\n`)
    expect(grown).not.toBe(first)
    expect(grown.startsWith(importLineageOf('foreign-1'))).toBe(true)
    expect(importLineageOf('foreign-2')).not.toBe(importLineageOf('foreign-1'))
    expect(first).toMatch(/^session-imported-[0-9a-f]{16}-[0-9a-f]{16}$/u)
  })

  it('refuses importing the same text twice, whichever encoding carried it', async () => {
    const f = await createContextFixture()
    try {
      const imported = await f.importer.import({ artifact: zstdFrames(FOREIGN_TEXT), cwd: f.root })
      expect(imported.sessionId).toBe(importedSessionIdFor('foreign-1', FOREIGN_TEXT))
      const conflict = f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.join('elsewhere') })
      await expect(conflict).rejects.toBeInstanceOf(ImportConflictError)
      await expect(conflict).rejects.toMatchObject({ sessionId: imported.sessionId })
      expect((await f.persistence.list()).map(header => header.id)).toEqual([imported.sessionId])
    } finally { await f.dispose() }
  })

  it('reports a contender that won the directory race as a conflict', async () => {
    const f = await createContextFixture()
    try {
      const id = importedSessionIdFor('foreign-1', FOREIGN_TEXT)
      const location = f.persistence.locate({ version: 0, id, createdAt: 1000, cwd: f.root })!
      await mkdir(dirname(location.path), { recursive: true })
      await expect(f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.root }))
        .rejects.toMatchObject({ name: 'ImportConflictError', sessionId: id })
    } finally { await f.dispose() }
  })

  it('surfaces directory failures other than an existing contender', async () => {
    const f = await createContextFixture()
    try {
      // One path segment longer than any filesystem admits.
      const id = SessionId(`session-${'x'.repeat(300)}`)
      const failure = f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.root, sessionId: id })
      await expect(failure).rejects.toHaveProperty('code', expect.any(String))
      await expect(failure).rejects.not.toBeInstanceOf(ImportConflictError)
    } finally { await f.dispose() }
  })
})

describe('Zstandard and text decoding', () => {
  it('imports a multi-frame official log and retains its exact compressed bytes', async () => {
    const f = await createContextFixture()
    try {
      const source = zstdFrames(await officialArtifact(4))
      const result = await f.importer.import({ artifact: source, cwd: f.root })
      expect(result.artifactName).toBe(`${encodeURIComponent(result.sessionId)}.source.jsonl.zstd`)
      const location = f.persistence.locate({ version: 0, id: result.sessionId, createdAt: 1, cwd: f.root })!
      const { readFile } = await import('node:fs/promises')
      expect(Buffer.compare(await readFile(`${dirname(location.path)}/${result.artifactName}`), source)).toBe(0)
      const session = await f.loadedSession(result.sessionId)
      expect(JSON.stringify(session.deriveMessages())).toContain('TERMINAL_OK')
    } finally { await f.dispose() }
  })

  it('refuses corrupt framing and non-UTF-8 text as foreign-log errors', async () => {
    const f = await createContextFixture()
    try {
      const corrupt = Buffer.concat([zstdCompressSync(Buffer.from('x\n')), Buffer.from('garbage!')])
      const failure = f.importer.import({ artifact: corrupt, cwd: f.root })
      await expect(failure).rejects.toBeInstanceOf(ForeignLogError)
      await expect(failure).rejects.toThrow(/cannot import the uploaded artifact: its Zstandard framing is corrupt: .*invalid frame magic/)
      await expect(f.importer.import({ artifact: Buffer.from([0xFF, 0xFE, 0x00]), cwd: f.root }))
        .rejects.toThrow(new ForeignLogError('cannot import the uploaded artifact: it is not UTF-8 text'))
      expect(await f.persistence.list()).toEqual([])
    } finally { await f.dispose() }
  })
})

describe('artifact description', () => {
  it('describes provenance, display facts, and the archive identity without persisting', async () => {
    const f = await createContextFixture()
    try {
      const summary = f.importer.describe(Buffer.from(FOREIGN_TEXT))
      expect(summary).toEqual({
        format: 'official-v3',
        sourceSessionId: 'foreign-1',
        sourceCwd: '/foreign/home',
        createdAt: 1000,
        // Event times older than the header never move the update time back.
        updatedAt: 1000,
        title: undefined,
        preview: 'Summarize the repo.',
        turns: 1,
        sessionId: importedSessionIdFor('foreign-1', FOREIGN_TEXT),
        lineage: importLineageOf('foreign-1'),
      })
      expect(await f.persistence.list()).toEqual([])
      const official = f.importer.describe(zstdFrames(await officialArtifact(4)))
      expect(official).toMatchObject({ format: 'official-v4', title: 'Use the bash tool to', turns: 1 })
      expect(official.updatedAt).toBeGreaterThan(official.createdAt)
    } finally { await f.dispose() }
  })

  it('previews the first human prompt with text as one bounded line', async () => {
    const f = await createContextFixture()
    try {
      const rows = FOREIGN_TEXT.split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      const prompt = rows[2] as { data: { content: unknown[]; source: unknown } }
      const blank = structuredClone(prompt) as typeof prompt & { data: { id: string } }
      blank.data.id = 'blank-prompt'
      blank.data.content = [{ type: 'text', text: '   ' }]
      prompt.data.content = [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: `  line one\n\n${'字'.repeat(200)}` }]
      const context = structuredClone(prompt) as typeof prompt & { data: { id: string } }
      context.data.id = 'context-message'
      context.data.source = { kind: 'plugin', plugin: 'runtime-context' }
      // A context message and a text-free prompt precede the real prompt.
      const text = [rows[0], rows[1], { ...context, seq: 1 }, { ...blank, seq: 2 }, { ...prompt, seq: 3 },
        ...rows.slice(3).map(row => ({ ...row, seq: (row.seq as number) + 2 }))]
        .map(row => JSON.stringify(row)).join('\n')
      const preview = f.importer.describe(Buffer.from(text)).preview!
      expect(Array.from(preview)).toHaveLength(160)
      expect(preview.startsWith('line one 字字')).toBe(true)
      const silent = FOREIGN_TEXT.split('\n').filter((_line, index) => index !== 2)
        .map((line, index) => index === 0 ? line : JSON.stringify({ ...JSON.parse(line) as object, seq: index - 1 })).join('\n')
      expect(f.importer.describe(Buffer.from(silent)).preview).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('refuses native and unknown generations', async () => {
    const f = await createContextFixture()
    try {
      expect(() => f.importer.describe(Buffer.from(FOREIGN_TEXT.replace('"version":3', '"version":0'))))
        .toThrow(/native format — restore it instead/)
      expect(() => f.importer.describe(Buffer.from(FOREIGN_TEXT.replace('"version":3', '"version":9'))))
        .toThrow(/unknown session format version 9/)
    } finally { await f.dispose() }
  })
})

describe('archive provenance and settlement publication', () => {
  it('records foreign provenance in the marker, keeps the title, and announces the settled header', async () => {
    const f = await createContextFixture()
    const announced: SessionHeader[] = []
    f.ctx.on('session/imported', (header) => { announced.push(header) })
    try {
      const result = await f.importer.import({ artifact: Buffer.from(await officialArtifact(4)), cwd: f.root })
      expect(result).toMatchObject({ sourceSessionId: expect.any(String) as string, title: 'Use the bash tool to' })
      expect(announced).toEqual([{ version: 0, id: result.sessionId, createdAt: expect.any(Number) as number, cwd: f.root }])
      const session = await f.loadedSession(result.sessionId)
      expect(session.eventAt(0)).toMatchObject({
        type: 'import/record',
        data: { source: { format: 'official-v4', sessionId: result.sourceSessionId, cwd: expect.any(String) as string } },
      })
      const title = session.events.findLast(event => event.type === 'session/title')
      expect(title?.data).toEqual({ title: 'Use the bash tool to', messageSeqs: [], source: { kind: 'user' } })
      const untitled = await f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.root })
      expect(untitled).not.toHaveProperty('title')
    } finally { await f.dispose() }
  })

  it('omits the working directory from the marker when the source recorded none', async () => {
    const f = await createContextFixture()
    try {
      const text = FOREIGN_TEXT.replace('"cwd":"/foreign/home",', '')
      const result = await f.importer.import({ artifact: Buffer.from(text), cwd: f.root })
      const session = await f.loadedSession(result.sessionId)
      expect(session.eventAt(0)?.data).toEqual({
        source: { format: 'official-v3', artifactName: result.artifactName, sessionId: 'foreign-1' },
        posture: { supervisionMode: 'supervised' },
      })
    } finally { await f.dispose() }
  })

  it('projects archival provenance on archives and null elsewhere', async () => {
    const f = await createContextFixture()
    try {
      await f.ctx.plugin(SessionProjectionRegistry)
      const registry = f.ctx.get('sessionProjections') as SessionProjectionRegistry
      const result = await f.importer.import({ artifact: Buffer.from(FOREIGN_TEXT), cwd: f.root })
      const archive = await f.loadedSession(result.sessionId)
      expect(registry.restore({}, archive.events, 0).snapshot.values.sessionImport)
        .toEqual({ format: 'official-v3', sourceSessionId: 'foreign-1', sourceCwd: '/foreign/home' })
      const legacy = archive.events.map((event, index) => index === 0
        ? { ...event, data: { source: { format: 'official-v3', artifactName: 'a.jsonl' }, posture: { supervisionMode: 'supervised' } } }
        : event) as typeof archive.events
      expect(registry.restore({}, legacy, 0).snapshot.values.sessionImport).toEqual({ format: 'official-v3' })
      const native = Session.create(SessionId('native'), [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
      expect(registry.restore({}, native.events, 0).snapshot.values.sessionImport).toBeNull()
    } finally { await f.dispose() }
  })
})
