import { describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { createContextFixture } from './import-fixture.ts'

describe('import settlement boundaries', () => {
  it('requires exactly one source without creating any stored session', async () => {
    const f = await createContextFixture()
    try {
      await expect(f.importer.import({ cwd: f.root })).rejects.toThrow('supply exactly one artifactPath or artifact')
      await expect(f.importer.import({ cwd: f.root, artifact: Buffer.from(f.foreignText), artifactPath: f.artifactPath }))
        .rejects.toThrow('supply exactly one artifactPath or artifact')
      expect(await f.persistence.list()).toEqual([])
    } finally { await f.dispose() }
  })

  it('imports an empty history with the header timestamp on its origin message', async () => {
    const f = await createContextFixture()
    try {
      const artifact = Buffer.from(f.foreignText.split('\n')[0]!)
      const result = await f.importer.import({ artifact, cwd: f.root })
      expect(result).toMatchObject({ mappedEvents: 0, skippedEvents: 0 })
      const loaded = await f.persistence.load(result.sessionId)
      expect(loaded.events).toMatchObject([
        { seq: 0, type: 'import/record', time: 1000 },
        { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'plugin' } } },
      ])
      expect(await f.readArtifact(result.sessionId, result.artifactName)).toBe(artifact.toString())
    } finally { await f.dispose() }
  })

  it('removes its source directory when persistence creation fails and permits retry', async () => {
    const f = await createContextFixture()
    try {
      const id = f.sessionId('create-failure')
      const location = f.persistence.locate({ version: 0, id, createdAt: 1000, cwd: f.root })!
      vi.spyOn(f.persistence, 'create').mockRejectedValueOnce(new Error('create failed'))
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: id })).rejects.toThrow('create failed')
      await expect(stat(dirname(location.path))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await f.persistence.list()).toEqual([])
      const imported = await f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: id })
      expect(await f.readArtifact(id, imported.artifactName)).toBe(f.foreignText)
    } finally { vi.restoreAllMocks(); await f.dispose() }
  })

  it('retains the source and surviving log if rollback deletion fails', async () => {
    const f = await createContextFixture()
    try {
      const id = f.sessionId('rollback-failure')
      const append = f.persistence.append.bind(f.persistence)
      vi.spyOn(f.persistence, 'append').mockImplementationOnce(async (sessionId, events) => {
        await append(sessionId, events)
        throw new Error('append failed')
      })
      vi.spyOn(f.persistence, 'delete').mockRejectedValueOnce(new Error('rollback failed'))
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: id })).rejects.toThrow('rollback failed')
      expect(await f.readArtifact(id, 'rollback-failure.source.jsonl')).toBe(f.foreignText)
      expect((await f.persistence.load(id)).events[0]).toMatchObject({ type: 'import/record' })
    } finally { vi.restoreAllMocks(); await f.dispose() }
  })

  it('attaches archival admission when agents arrive and removes it on importer disposal', async () => {
    const f = await createContextFixture()
    try {
      await f.ctx.plugin(AgentRegistry)
      const result = await f.importer.import({ artifactPath: f.artifactPath, cwd: f.root })
      const loaded = await f.persistence.load(result.sessionId)
      const archived = Session.create(result.sessionId, loaded.events, loaded.meta)
      expect(() => { f.ctx.agents.assertAdmission(Session.create(f.sessionId('empty'))) }).not.toThrow()
      expect(() => { f.ctx.agents.assertAdmission(archived) }).toThrow('imported')
      await f.disposeImporter()
      expect(() => { f.ctx.agents.assertAdmission(archived) }).not.toThrow()
    } finally { await f.dispose() }
  })
})
