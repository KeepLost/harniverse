import { createContextFixture } from './import-fixture.ts'

import { describe, expect, it } from 'vitest'

describe('SessionImport runtime over the JSONL backend', () => {
  it('imports a foreign artifact lossily, marks it archival, and retains the source', async () => {
    const fixture = await createContextFixture()
    try {
      const result = await fixture.importer.import({ artifactPath: fixture.artifactPath })
      expect(result.format).toBe('official-v3')
      expect(result.mappedEvents).toBe(7)
      expect(result.skippedEvents).toBe(1)
      expect(String(result.sessionId)).toMatch(/^session-/)

      const inspection = await fixture.persistence.load(result.sessionId)
      expect(inspection.events[0]).toMatchObject({ type: 'import/record' })
      if (inspection.events[0]?.type !== 'import/record') return
      expect(inspection.events[0].data.source).toEqual({
        format: 'official-v3',
        artifactName: `${String(result.sessionId)}.source.jsonl`,
      })
      expect(inspection.events[0].data.posture).toEqual({ supervisionMode: 'supervised' })
      expect(inspection.meta.version).toBe(0)
      expect(inspection.events.map(event => event.seq)).toEqual(inspection.events.map((_, index) => index))
      const types = inspection.events.map(event => event.type)
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('tool/result')
      expect(types).not.toContain('request/header')

      const artifactText = await fixture.readArtifact(result.sessionId, result.artifactName)
      expect(artifactText).toBe(fixture.foreignText)

      const listed = await fixture.persistence.list()
      expect(listed.map(header => header.id)).toContain(result.sessionId)
    } finally {
      await fixture.dispose()
    }
  })

  it('applies an explicit posture and honors an explicit session id', async () => {
    const fixture = await createContextFixture()
    try {
      const result = await fixture.importer.import({
        artifactPath: fixture.artifactPath,
        sessionId: fixture.sessionId('named-import'),
        posture: { supervisionMode: 'unsupervised' },
      })
      const inspection = await fixture.persistence.load(result.sessionId)
      const marker = inspection.events[0]
      if (marker?.type !== 'import/record') throw new Error('missing marker')
      expect(marker.data.posture).toEqual({ supervisionMode: 'unsupervised' })
      expect(marker.data.source.artifactName).toBe('named-import.source.jsonl')
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses a native-version artifact and an unknown version', async () => {
    const fixture = await createContextFixture()
    try {
      await expect(fixture.importWithVersion(0, 'current.txt')).rejects.toThrow('restore it instead')
      await expect(fixture.importWithVersion(9, 'unknown.txt')).rejects.toThrow('unknown session format version 9')
      const listed = await fixture.persistence.list()
      expect(listed).toHaveLength(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses an invalid posture before touching persistence', async () => {
    const fixture = await createContextFixture()
    try {
      await expect(fixture.importer.import({
        artifactPath: fixture.artifactPath,
        posture: { supervisionMode: 'nonsense' } as never,
      })).rejects.toThrow(TypeError)
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses an unreadable artifact loudly', async () => {
    const fixture = await createContextFixture()
    try {
      await expect(fixture.importer.import({ artifactPath: fixture.join('missing.jsonl') }))
        .rejects.toThrow()
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses to reuse an existing session id', async () => {
    const fixture = await createContextFixture()
    try {
      const id = fixture.sessionId('dup-import')
      await fixture.importer.import({ artifactPath: fixture.artifactPath, sessionId: id })
      await expect(fixture.importer.import({ artifactPath: fixture.artifactPath, sessionId: id })).rejects.toThrow()
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses import when the backend cannot retain the source artifact', async () => {
    const fixture = await createContextFixture({ locateUndefined: true })
    try {
      await expect(fixture.importer.import({ artifactPath: fixture.artifactPath }))
        .rejects.toThrow('no per-session artifact location')
    } finally {
      await fixture.dispose()
    }
  })

  it('yields display-compatible derived history through the native fold', async () => {
    const fixture = await createContextFixture()
    try {
      const result = await fixture.importer.import({ artifactPath: fixture.artifactPath })
      const session = await fixture.loadedSession(result.sessionId)
      const user = session.events.find(event => event.type === 'user/message')
      expect(user).toBeDefined()
      const derived = session.deriveMessages()
      expect(derived.at(0)?.content).toEqual([{ type: 'text', text: 'Summarize the repo.' }])
      expect(derived.some(message => message.role === 'assistant')).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })
})

describe('importer header fallbacks', () => {
  it('imports a header without createdAt or cwd using local defaults', async () => {
    const fixture = await createContextFixture()
    try {
      const minimalPath = fixture.join('minimal-export.jsonl')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(minimalPath, `${JSON.stringify({ version: 1 })}\n${JSON.stringify({ type: 'turn/start', data: { turn: 1 }, time: 3 })}\n`, 'utf8')
      const result = await fixture.importer.import({ artifactPath: minimalPath })
      const inspection = await fixture.persistence.load(result.sessionId)
      expect(inspection.meta.createdAt).toBeGreaterThan(0)
      expect(inspection.meta.cwd).toBeUndefined()
      expect(inspection.events).toHaveLength(3)
    } finally {
      await fixture.dispose()
    }
  })
})
