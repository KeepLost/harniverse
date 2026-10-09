import { describe, expect, it } from 'vitest'
import type { OfficialSessionCandidate, OfficialSessionScan, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createArchiveDockStore, createSessionImportStore } from '../src/client/stores.ts'

function candidate(sourceId: string): OfficialSessionCandidate {
  return {
    sourceId, path: `/r/${sourceId}`, format: 'official-v4', sourceSessionId: sourceId, turns: 1,
    createdAt: 1, updatedAt: 2, sizeBytes: 3, status: 'new',
  }
}

function scan(...ids: string[]): OfficialSessionScan {
  return { roots: ['/r'], items: ids.map(candidate), unreadable: [], maxArtifactBytes: 10 }
}

describe('session import store', () => {
  it('moves through scan phases, keeping the last scan across a failed rescan', () => {
    const store = createSessionImportStore().create()
    store.actions.scanStarted()
    expect(store.getSnapshot().phase).toBe('scanning')
    store.actions.scanFailed('offline')
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', scanError: 'offline' })
    store.actions.scanLoaded(scan('a', 'b'))
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', scanError: null })
    store.actions.scanStarted()
    expect(store.getSnapshot().phase).toBe('ready')
    store.actions.scanFailed('again')
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', scanError: 'again', scan: { items: [{ sourceId: 'a' }, { sourceId: 'b' }] } })
  })

  it('keeps selections to listed candidates and drops settled ones', () => {
    const store = createSessionImportStore().create()
    store.actions.scanLoaded(scan('a', 'b', 'c'))
    store.actions.toggle('a')
    store.actions.toggle('b')
    store.actions.toggle('b')
    store.actions.setSelected(['a', 'c'])
    store.actions.scanLoaded(scan('a', 'c'))
    expect(store.getSnapshot().selected).toEqual(['a', 'c'])
    store.actions.importStarted()
    expect(store.getSnapshot().importing).toBe(true)
    store.actions.importSettled([
      { source: 'a', label: 'A', outcome: { status: 'already-imported', sessionId: 's' } },
      { source: 'c', label: 'C', outcome: { status: 'failed', reason: 'invalid', message: 'm' } },
    ])
    expect(store.getSnapshot()).toMatchObject({ importing: false, selected: ['c'] })
  })

  it('records refusals, targets, and resets to the initial state', () => {
    const store = createSessionImportStore().create()
    store.actions.setTarget({ kind: 'workspace', workspaceId: 'w' })
    store.actions.importStarted()
    store.actions.refuse('too big')
    expect(store.getSnapshot()).toMatchObject({ importing: false, uploadError: 'too big', target: { kind: 'workspace', workspaceId: 'w' } })
    store.actions.importStarted()
    expect(store.getSnapshot().uploadError).toBeNull()
    store.actions.reset()
    expect(store.getSnapshot()).toEqual({
      phase: 'idle', scan: null, scanError: null, selected: [], target: { kind: 'source-cwd' }, importing: false, results: [], uploadError: null,
    })
  })
})

describe('archive dock store', () => {
  it('tracks the preset roster and per-archive continuation progress', () => {
    const store = createArchiveDockStore().create()
    const a = 'a' as SessionId
    store.actions.presetsLoading()
    expect(store.getSnapshot().presets.status).toBe('loading')
    store.actions.presetsLoaded([{ id: 'p' }])
    expect(store.getSnapshot().presets).toEqual({ status: 'ready', options: [{ id: 'p' }] })
    store.actions.presetsFailed()
    expect(store.getSnapshot().presets.status).toBe('error')
    store.actions.continueStarted(a)
    store.actions.continueFailed(a, 'nope')
    expect(store.getSnapshot()).toMatchObject({ pending: [], errors: { a: 'nope' } })
    store.actions.continueStarted(a)
    store.actions.continueStarted(a)
    expect(store.getSnapshot()).toMatchObject({ pending: ['a'], errors: {} })
    store.actions.continueSettled(a)
    expect(store.getSnapshot().pending).toEqual([])
  })
})
