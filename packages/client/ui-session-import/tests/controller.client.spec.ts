import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MachineTargetSource, OfficialImportResult, OfficialSessionScan, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createArchiveDockController, createSessionImportController, OPEN_WAIT_MS,
  type ArchiveDockDeps, type SessionImportDeps,
} from '../src/client/controller.ts'
import { createArchiveDockStore, createSessionImportStore } from '../src/client/stores.ts'

afterEach(() => {
  vi.useRealTimers()
})

const SCAN: OfficialSessionScan = { roots: ['/r'], items: [], unreadable: [], maxArtifactBytes: 100 }
const MACHINE: MachineTargetSource = { getSnapshot: () => ({ kind: 'host' }), subscribe: () => () => {} } as unknown as MachineTargetSource
const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'internal', message, details: {} } })

function remoteDouble() {
  return {
    scan: vi.fn(async () => ok(SCAN)),
    importSources: vi.fn(async (sourceIds: string[]) => ok(sourceIds.map((source): OfficialImportResult => ({
      source, outcome: { status: 'already-imported', sessionId: `archive-${source}` },
    })))),
    importUpload: vi.fn(async (fileName: string) => ok<OfficialImportResult>({
      source: fileName, outcome: { status: 'imported', sessionId: 'archive-upload', workspaceId: 'w' as never, attached: true, mappedEvents: 1, skippedEvents: 0 },
    })),
  }
}

function listDouble(initial: string[] = []) {
  let ids = new Set(initial)
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => ({ byId: Object.fromEntries([...ids].map(id => [id, { id }])) }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    open: vi.fn(),
    listeners,
    add(id: string) {
      ids = new Set([...ids, id])
      for (const listener of [...listeners]) listener()
    },
  }
}

function section(remote = remoteDouble(), sessions = listDouble()) {
  const store = createSessionImportStore().create()
  const deps: SessionImportDeps = {
    remote,
    sessions: sessions as unknown as SessionImportDeps['sessions'],
    machine: MACHINE,
    copy: { tooLarge: (size, limit) => `${size}>${limit}`, readError: message => `read:${message}` },
  }
  return { store, remote, sessions, face: createSessionImportController(deps, store.actions) }
}

describe('session import controller', () => {
  it('scans, publishing the latest scan and folding failures', async () => {
    const s = section()
    expect(s.face.hooks.machine).toBe(MACHINE)
    await s.face.scan()
    expect(s.store.getSnapshot()).toMatchObject({ phase: 'ready', scan: SCAN })
    s.remote.scan.mockResolvedValueOnce(fail('offline') as never)
    await s.face.scan()
    expect(s.store.getSnapshot()).toMatchObject({ phase: 'ready', scanError: 'offline' })
  })

  it('drops a scan superseded by a newer one', async () => {
    const s = section()
    let release: (value: unknown) => void = () => {}
    s.remote.scan.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }) as never)
    const stale = s.face.scan()
    await s.face.scan()
    release(fail('stale'))
    await stale
    expect(s.store.getSnapshot()).toMatchObject({ phase: 'ready', scanError: null })
  })

  it('imports a selection with row labels, then rescans', async () => {
    const s = section()
    await s.face.importSelected(['a', 'b'], { kind: 'workspace', workspaceId: 'w-1' }, { a: 'Session A' })
    expect(s.remote.importSources).toHaveBeenCalledWith(['a', 'b'], { kind: 'workspace', workspaceId: 'w-1' })
    expect(s.store.getSnapshot().results.map(result => [result.source, result.label])).toEqual([['a', 'Session A'], ['b', 'b']])
    expect(s.remote.scan).toHaveBeenCalledOnce()
    s.remote.importSources.mockResolvedValueOnce(fail('host down') as never)
    await s.face.importSelected(['a', 'c'], { kind: 'source-cwd' }, { a: 'Session A' })
    expect(s.remote.importSources).toHaveBeenLastCalledWith(['a', 'c'], { kind: 'source-cwd' })
    expect(s.store.getSnapshot().results).toEqual([
      { source: 'a', label: 'Session A', outcome: { status: 'failed', reason: 'failed', message: 'host down' } },
      { source: 'c', label: 'c', outcome: { status: 'failed', reason: 'failed', message: 'host down' } },
    ])
  })

  it('uploads a file as base64 under its name, refusing oversized and unreadable files first', async () => {
    const s = section()
    const file = new File([new Uint8Array([1, 2, 3])], 'session.v4.jsonl.zstd')
    await s.face.importFile(file, { kind: 'source-cwd' }, 100)
    expect(s.remote.importUpload).toHaveBeenCalledWith('session.v4.jsonl.zstd', 'AQID', { kind: 'source-cwd' })
    expect(s.store.getSnapshot().results).toEqual([expect.objectContaining({ source: 'session.v4.jsonl.zstd', label: 'session.v4.jsonl.zstd' })])
    await s.face.importFile(file, { kind: 'source-cwd' }, 2)
    expect(s.store.getSnapshot().uploadError).toBe('3 B>2 B')
    const broken = { size: 1, name: 'x', arrayBuffer: () => Promise.reject(new Error('gone')) } as unknown as File
    await s.face.importFile(broken, { kind: 'source-cwd' }, 100)
    expect(s.store.getSnapshot()).toMatchObject({ uploadError: 'read:gone', importing: false })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const opaque = { size: 1, name: 'x', arrayBuffer: () => Promise.reject('nope') } as unknown as File
    await s.face.importFile(opaque, { kind: 'source-cwd' }, 100)
    expect(s.store.getSnapshot().uploadError).toBe('read:nope')
    s.remote.importUpload.mockResolvedValueOnce(fail('refused') as never)
    await s.face.importFile(file, { kind: 'source-cwd' }, 100)
    expect(s.store.getSnapshot().results).toEqual([{ source: 'session.v4.jsonl.zstd', label: 'session.v4.jsonl.zstd', outcome: { status: 'failed', reason: 'failed', message: 'refused' } }])
  })

  it('opens a listed archive at once and waits for one still arriving', async () => {
    const sessions = listDouble(['ready'])
    const s = section(remoteDouble(), sessions)
    expect(await s.face.openSession('ready')).toBe(true)
    expect(sessions.open).toHaveBeenCalledWith('ready')
    const arriving = s.face.openSession('late')
    sessions.add('other')
    sessions.add('late')
    expect(await arriving).toBe(true)
    expect(sessions.open).toHaveBeenLastCalledWith('late')
    expect(sessions.listeners.size).toBe(0)
  })

  it('gives up opening an archive that never arrives', async () => {
    vi.useFakeTimers()
    const sessions = listDouble()
    const s = section(remoteDouble(), sessions)
    const waiting = s.face.openSession('missing')
    await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS)
    expect(await waiting).toBe(false)
    expect(sessions.open).not.toHaveBeenCalled()
    expect(sessions.listeners.size).toBe(0)
  })
})

describe('archive dock controller', () => {
  function dock(list: () => Promise<unknown>, continueArchive = vi.fn(async () => 'child' as SessionId)) {
    const store = createArchiveDockStore().create()
    const deps = {
      api: { agentPresets: { list: vi.fn(list) } },
      sessions: { continueArchive, open: vi.fn() },
    }
    const face = createArchiveDockController(deps as unknown as ArchiveDockDeps, 'archive' as SessionId, store.actions)
    return { store, deps, face }
  }

  it('lists usable presets with their published names', async () => {
    const d = dock(async () => ({ result: ok({ presets: [{ id: 'coder', name: 'Coder' }, { id: 'plain' }, { id: 'bad', broken: 'x' }] }) }))
    await d.face.loadPresets()
    expect(d.store.getSnapshot().presets).toEqual({ status: 'ready', options: [{ id: 'coder', name: 'Coder' }, { id: 'plain' }] })
  })

  it('marks the roster failed on a refusal or a rejected wire', async () => {
    const refused = dock(async () => ({ result: fail('no') }))
    await refused.face.loadPresets()
    expect(refused.store.getSnapshot().presets.status).toBe('error')
    const rejected = dock(() => Promise.reject(new Error('socket')))
    await rejected.face.loadPresets()
    expect(rejected.store.getSnapshot().presets.status).toBe('error')
  })

  it('continues under a chosen or default preset and opens the continuation', async () => {
    const d = dock(async () => ({ result: ok({ presets: [] }) }))
    await d.face.continueArchive('coder')
    expect(d.deps.sessions.continueArchive).toHaveBeenCalledWith({ sessionId: 'archive', agentProfile: 'coder' })
    await d.face.continueArchive('')
    expect(d.deps.sessions.continueArchive).toHaveBeenLastCalledWith({ sessionId: 'archive' })
    expect(d.deps.sessions.open).toHaveBeenCalledWith('child')
    expect(d.store.getSnapshot().pending).toEqual([])
  })

  it('reports a failed continuation for that archive', async () => {
    const d = dock(async () => ({ result: ok({ presets: [] }) }), vi.fn(() => Promise.reject(new Error('fork-unavailable'))))
    await d.face.continueArchive('')
    expect(d.store.getSnapshot()).toMatchObject({ pending: [], errors: { archive: 'fork-unavailable' } })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const opaque = dock(async () => ({ result: ok({ presets: [] }) }), vi.fn(() => Promise.reject('opaque')))
    await opaque.face.continueArchive('')
    expect(opaque.store.getSnapshot().errors).toEqual({ archive: 'opaque' })
    expect(opaque.deps.sessions.open).not.toHaveBeenCalled()
  })
})
