import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createContextFixture, officialArtifact } from './import-fixture.ts'

describe('archival import settlement', () => {
  it.each([1, 2, 3] as const)('imports the frozen official v%i recording and cold-reloads it', async (version) => {
    const f = await createContextFixture()
    const source = Buffer.from(await officialArtifact(version))
    const reopened = new Context()
    try {
      const result = await f.importer.import({ artifact: source, cwd: f.root, posture: { supervisionMode: 'unsupervised' } })
      expect(result.format).toBe(`official-v${version}`)
      expect(await f.readArtifact(result.sessionId, result.artifactName)).toBe(source.toString())
      expect(f.ctx.sessions.list()).toEqual([])
      await f.ctx.fiber.dispose()
      await reopened.plugin(SessionStore)
      await reopened.plugin(JsonlSessionPersistence, { root: f.root })
      const loaded = await reopened.sessionPersistence.inspect(result.sessionId)
      const session = Session.create(result.sessionId, loaded.events, loaded.meta)
      expect(loaded.meta.cwd).toBe(f.root)
      expect(session.eventAt(0)).toMatchObject({ type: 'import/record', data: { posture: { supervisionMode: 'unsupervised' } } })
      const messages = session.deriveMessages()
      expect(messages.at(-1)).toMatchObject({ source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-session-import' } })
      expect(JSON.stringify(messages.at(-1))).toContain(`official-v${version}`)
      expect(JSON.stringify(messages)).toContain(version === 1 ? 'PONG' : 'dsh-sdk-proof-7391')
      expect(messages.some(message => message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt')).toBe(true)
      if (version !== 1) {
        const resultMessage = messages.find(message => message.source.kind === 'tool')
        expect(resultMessage?.content).toEqual([{
          type: 'tool-result', toolCallId: 'call_00_Ry17evSfTr0uJnHhg3X93070',
          content: [{ type: 'text', text: 'dsh-sdk-proof-7391\n' }], isError: false,
        }])
      }
      expect((await reopened.sessionPersistence.list()).map(header => header.id)).toContain(result.sessionId)
      expect(reopened.sessions.list()).toEqual([])
    } finally { await reopened.fiber.dispose(); await f.dispose() }
  })

  it('retains exact BOM/CRLF bytes before publishing and rolls back a failed publication for retry', async () => {
    const f = await createContextFixture()
    try {
      const source = Buffer.from('\uFEFF' + f.foreignText.replaceAll('\n', '\r\n') + '\r\n')
      const id = f.sessionId('retry-import')
      const append = f.persistence.append.bind(f.persistence)
      const fault = vi.spyOn(f.persistence, 'append').mockImplementationOnce(async (sessionId, events) => {
        expect(await f.readArtifact(sessionId, 'retry-import.source.jsonl')).toBe(source.toString())
        await append(sessionId, events)
        throw new Error('publication failed')
      })
      await expect(f.importer.import({ artifact: source, cwd: f.root, sessionId: id })).rejects.toThrow('publication failed')
      expect(await f.persistence.list()).toEqual([])
      fault.mockRestore()
      const imported = await f.importer.import({ artifact: source, cwd: f.root, sessionId: id })
      const before = await f.readArtifact(id, imported.artifactName)
      await expect(f.importer.import({ artifact: Buffer.from(f.foreignText), cwd: f.root, sessionId: id })).rejects.toThrow()
      expect(await f.readArtifact(id, imported.artifactName)).toBe(before)
    } finally { vi.restoreAllMocks(); await f.dispose() }
  })

  it('leaves an existing source directory untouched and permits retry after the obstruction is removed', async () => {
    const f = await createContextFixture()
    try {
      const id = f.sessionId('obstructed')
      const location = f.persistence.locate({ version: 0, id, createdAt: 1000, cwd: f.root })!
      await mkdir(dirname(location.path), { recursive: true })
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: id })).rejects.toThrow()
      expect(await f.persistence.list()).toEqual([])
      await rm(dirname(location.path), { recursive: true })
      await f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: id })
      expect((await f.persistence.list()).map(header => header.id)).toContain(id)
    } finally { await f.dispose() }
  })

  it('uses the destination workspace even when the foreign cwd is missing or Windows-specific', async () => {
    const f = await createContextFixture()
    try {
      for (const cwd of [undefined, 'C:\\foreign\\project']) {
        const [first, ...rest] = f.foreignText.split('\n')
        const header = { ...JSON.parse(first!) as Record<string, unknown>, cwd }
        const artifact = Buffer.from([JSON.stringify(header), ...rest].join('\n'))
        const imported = await f.importer.import({ artifact, cwd: f.root })
        expect((await f.persistence.load(imported.sessionId)).meta.cwd).toBe(f.root)
      }
    } finally { await f.dispose() }
  })

  it('refuses malformed bytes, posture, destination, native versions, and unknown versions without publishing', async () => {
    const f = await createContextFixture()
    try {
      await expect(f.importer.import({ artifact: new Uint8Array([0xff]), cwd: f.root })).rejects.toThrow()
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: 'relative' })).rejects.toThrow('destination workspace')
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, posture: { supervisionMode: 'invalid' } as never })).rejects.toThrow(TypeError)
      await expect(f.importWithVersion(0, 'native.jsonl')).rejects.toThrow('restore it instead')
      await expect(f.importWithVersion(9, 'unknown.jsonl')).rejects.toThrow('unknown session format')
      expect(await f.persistence.list()).toEqual([])
      expect(await readFile(f.artifactPath, 'utf8')).toBe(f.foreignText)
    } finally { await f.dispose() }
  })

  it('refuses a backend without source artifact storage', async () => {
    const f = await createContextFixture({ locateUndefined: true })
    try {
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root })).rejects.toThrow('no per-session artifact location')
    } finally { await f.dispose() }
  })
})
