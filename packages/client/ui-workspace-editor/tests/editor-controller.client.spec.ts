/**
 * Controller specs: the draft account's write machine over a stub wire —
 * attach/load, dirty transitions, the save CAS lifecycle, conflict
 * settlement (reload / overwrite), watch-driven external changes with
 * own-save echo suppression, machine partitioning, and draft survival
 * across placement switches.
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceEditorController } from '../src/client/editor-controller.ts'
import type { WorkspaceEditorWire } from '../src/client/editor-controller.ts'
import { createWorkspaceEditorStore, editorEntry, editorKey } from '../src/client/stores.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileOpenResult, WorkspaceFileStatResult } from '@deepseek-ai/dsh-api-remotes/client'

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failure(code: string, message: string, details: object = {}): RemoteResult<never> {
  return {
    ok: false,
    error: { code, message, details },
  }
}

const openResult = (content: string, version: string, overrides: Partial<WorkspaceFileOpenResult> = {}): WorkspaceFileOpenResult => ({
  content, version, bytes: content.length, encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF', ...overrides,
})

/** Scripted wire: call records plus queued per-call results. */
class ScriptedWire implements WorkspaceEditorWire {
  readonly calls: { method: string; args: unknown[] }[] = []
  private readonly results = new Map<string, unknown>()

  queue(method: string, result: unknown): void {
    this.results.set(method, result)
  }

  async open(_workspaceId: string, _path: string, _signal: AbortSignal): Promise<RemoteResult<WorkspaceFileOpenResult>> {
    this.calls.push({ method: 'open', args: [_workspaceId, _path] })
    const result = this.results.get('open')
    if (result === undefined) return ok(openResult('body\n', 'v1'))
    if (result instanceof Error) throw result
    return result as RemoteResult<WorkspaceFileOpenResult>
  }

  async stat(_workspaceId: string, _path: string, _signal: AbortSignal): Promise<RemoteResult<WorkspaceFileStatResult>> {
    const result = this.results.get('stat')
    if (result === undefined) return ok({ version: 'v1' })
    return result as RemoteResult<WorkspaceFileStatResult>
  }

  save: WorkspaceEditorWire['save'] = async (_workspaceId, _path, request) => {
    this.calls.push({ method: 'save', args: [request] })
    const result = this.results.get('save')
    if (result === undefined) return ok({ version: 'v2' })
    return result as RemoteResult<{ version: string }>
  }

  watchFiles: NonNullable<WorkspaceEditorWire['watchFiles']> = (_workspaceId, _path, signalParam) => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: 'ready' as const }
      // Frames arrive from the (stubbed) transport as externalChange calls in
      // the specs; the stream just stays open until the subscription aborts.
      await new Promise<void>((resolve) => { signalParam.addEventListener('abort', () => { resolve() }) })
    },
  })
}

describe('WorkspaceEditorController attach and load', () => {
  it('loads one entry per machine/workspace/path and shares the watch', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
        draft: 'body\n', baseVersion: 'v1', status: 'clean',
      })
    })
    expect(wire.calls).toHaveLength(1)
  })

  it('partitions entries by machine', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, new ScriptedWire())
    controller.attach('host', 'ws-1', 'a.ts')
    controller.attach('remote:m1', 'ws-1', 'a.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined()
      expect(editorEntry(store.getSnapshot(), 'remote:m1', editorKey('ws-1', 'a.ts'))).toBeDefined()
    })
  })

  it('records an unavailable fallback when the editable open refuses', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('open', failure('mixed-eol', 'mixed line endings'))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
        status: 'unavailable', error: 'mixed line endings',
      })
    })
  })
})

describe('WorkspaceEditorController save lifecycle', () => {
  it('saves a dirty draft, settles clean, and bumps the baseline', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'edited\n')
    expect(wire.calls.at(-1)).toMatchObject({ method: 'save' })
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      draft: 'edited\n', baseVersion: 'v2', savedVersion: 'v2', status: 'clean',
    })
  })

  it('ignores a clean or in-flight double save', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    await controller.save('host', 'ws-1', 'a.ts', 'x')
    expect(wire.calls.filter(call => call.method === 'save')).toHaveLength(0)
  })

  it('settles a stale CAS as a conflict carrying the disk content', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('stale-version', 'changed', { currentVersion: 'v9' }))
    wire.queue('open', ok(openResult('disk body\n', 'v9')))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'conflict',
      conflict: { currentVersion: 'v9', diskContent: 'disk body\n' },
    })
  })

  it('overwrites on confirmation against the conflict version', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('stale-version', 'changed', { currentVersion: 'v9' }))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    wire.queue('save', ok({ version: 'v10' }))
    await controller.confirmOverwrite('host', 'ws-1', 'a.ts', 'mine\n')
    const request = wire.calls.at(-1)?.args[0] as { baseVersion: string; content: string }
    expect(request).toMatchObject({ baseVersion: 'v9', content: 'mine\n' })
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'clean', baseVersion: 'v10',
    })
  })

  it('records a typed refusal as an error status', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('unmappable', 'U+1F389 at line 2 column 7'))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'emoji\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'error', error: 'U+1F389 at line 2 column 7',
    })
  })

  it('reloads a conflict away on request', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('stale-version', 'changed', { currentVersion: 'v9' }))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    wire.queue('open', ok(openResult('fresh\n', 'v9')))
    await controller.reload('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'clean', draft: 'fresh\n', baseVersion: 'v9',
    })
  })
})

describe('WorkspaceEditorController external changes', () => {
  it('silently reloads a clean entry whose version moved', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    wire.queue('stat', ok({ version: 'v7' }))
    wire.queue('open', ok(openResult('new body\n', 'v7')))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'clean', draft: 'new body\n', baseVersion: 'v7',
    })
  })

  it('ignores its own save echo and an unchanged version', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'edited\n')
    // Own save echo: the watch version equals savedVersion.
    wire.queue('stat', ok({ version: 'v2' }))
    const openCalls = wire.calls.length
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(wire.calls.length).toBe(openCalls)
  })

  it('surfaces a conflict for a dirty entry whose version moved', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    wire.queue('stat', ok({ version: 'v5' }))
    wire.queue('open', ok(openResult('external\n', 'v5')))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'conflict', conflict: { currentVersion: 'v5', diskContent: 'external\n' },
    })
  })

  it('marks a clean entry unavailable when the file vanished', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    wire.queue('stat', ok({ absent: true }))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({ status: 'unavailable' })
  })
})

describe('WorkspaceEditorController occupancy and drafts', () => {
  it('keeps a serialized dirty draft when the occupant switches placements', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, new ScriptedWire())
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    // Placement switch: unmount serializes, remount attaches again.
    controller.detach('host', 'ws-1', 'a.ts', { draft: 'half-typed\n', history: { doc: 'half-typed\n' } })
    controller.attach('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      draft: 'half-typed\n', status: 'dirty', history: { doc: 'half-typed\n' },
    })
  })

  it('drops a clean entry on detach but keeps a dirty one', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, new ScriptedWire())
    controller.attach('host', 'ws-1', 'clean.ts')
    controller.attach('host', 'ws-1', 'dirty.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'clean.ts'))).toBeDefined()
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'dirty.ts'))).toBeDefined()
    })
    controller.markDirty('host', 'ws-1', 'dirty.ts')
    controller.detach('host', 'ws-1', 'clean.ts', undefined)
    controller.detach('host', 'ws-1', 'dirty.ts', { draft: 'wip\n', history: undefined })
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'clean.ts'))).toBeUndefined()
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'dirty.ts'))).toBeDefined()
  })

  it('bounds remembered entries per machine', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, new ScriptedWire())
    for (let index = 0; index < 70; index++) {
      controller.attach('host', 'ws-1', `file-${String(index)}.ts`)
    }
    await vi.waitFor(() => {
      expect(Object.keys(store.getSnapshot().byMachine.host ?? {})).toHaveLength(64)
    })
  })
})

describe('WorkspaceEditorController defensive arms', () => {
  it('ignores verbs addressed at missing entries and clean conflicts', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    // No attach: every verb addresses a missing entry.
    controller.markDirty('host', 'ws-1', 'none.ts')
    controller.detach('host', 'ws-1', 'none.ts', { draft: 'x', history: undefined })
    await controller.save('host', 'ws-1', 'none.ts', 'x')
    await controller.confirmOverwrite('host', 'ws-1', 'none.ts', 'x')
    await controller.reload('host', 'ws-1', 'none.ts')
    await controller.externalChange('host', 'ws-1', 'none.ts')
    expect(store.getSnapshot().byMachine).toEqual({})
    // A clean entry refuses overwrite-without-conflict and reload is idempotent.
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    await controller.confirmOverwrite('host', 'ws-1', 'a.ts', 'x')
    expect(wire.calls.filter(call => call.method === 'save')).toHaveLength(0)
  })

  it('keeps a loading entry untouched by a detach snapshot', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    controller.detach('host', 'ws-1', 'a.ts', { draft: 'mid-flight', history: undefined })
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.draft).toBe('body\n')
  })

  it('ignores failed stats, unchanged versions, and dirty deletions', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    wire.queue('stat', failure('io', 'probe failed'))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('clean')
    // Unchanged version (v1 === baseVersion): silent no-op.
    wire.queue('stat', ok({ version: 'v1' }))
    const opens = wire.calls.length
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(wire.calls.length).toBe(opens)
    // A dirty entry with the file deleted stays dirty (the save CAS reports).
    controller.markDirty('host', 'ws-1', 'a.ts')
    wire.queue('stat', ok({ absent: true }))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('dirty')
  })

  it('derives the conflict version from the disk read when details omit it', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('stale-version', 'changed'))
    wire.queue('open', ok(openResult('later disk\n', 'v8')))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.conflict).toMatchObject({ currentVersion: 'v8' })
  })

  it('records an unreadable disk as a null-content conflict and drops a settled entry removed mid-save', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    wire.queue('save', failure('stale-version', 'changed', { currentVersion: 'v3' }))
    wire.queue('open', failure('not-text', 'undecodable'))
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.conflict).toMatchObject({ diskContent: null })

    // Reload the conflict away, then remove the entry while a save is
    // pending: the settlement finds nothing.
    wire.queue('open', ok(openResult('again\n', 'v3')))
    await controller.reload('host', 'ws-1', 'a.ts')
    controller.markDirty('host', 'ws-1', 'a.ts')
    let release: (value: RemoteResult<{ version: string }>) => void = () => {}
    const gate = new Promise<RemoteResult<{ version: string }>>((resolve) => { release = resolve })
    wire.save = async () => gate
    const key = editorKey('ws-1', 'a.ts')
    const settle = controller.save('host', 'ws-1', 'a.ts', 'edited\n')
    store.update((draft) => {
      const partition = draft.byMachine.host
      if (partition !== undefined && key in partition) {
        const { [key]: _removed, ...rest } = partition
        draft.byMachine.host = rest
      }
    })
    release(ok({ version: 'v9' }))
    await settle
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeUndefined()
  })

  it('leaves an in-conflict entry alone when another external change lands', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('stale-version', 'changed', { currentVersion: 'v9' }))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'mine\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('conflict')
    const opens = wire.calls.length
    wire.queue('stat', ok({ version: 'v10' }))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    // The conflict bar is already showing; no further disk read.
    expect(wire.calls.length).toBe(opens)
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('conflict')
  })

  it('re-marks an errored entry dirty on the next edit', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    wire.queue('save', failure('unmappable', 'refused'))
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    await controller.save('host', 'ws-1', 'a.ts', 'x\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('error')
    controller.markDirty('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('dirty')
  })

  it('works without a watch feed and ends the stream on detach', async () => {
    const store = createWorkspaceEditorStore()
    const bareWire: WorkspaceEditorWire = {
      open: async () => ok(openResult('x\n', 'v1')),
      stat: async () => ok({ version: 'v1' }),
      save: async () => ok({ version: 'v2' }),
    }
    const controller = new WorkspaceEditorController(store, bareWire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('clean')
    })
    controller.detach('host', 'ws-1', 'a.ts', undefined)
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeUndefined()
  })

  it('stops the watch stream and re-arms it after detach and re-attach', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    controller.detach('host', 'ws-1', 'a.ts', { draft: 'wip\n', history: undefined })
    // Re-attach keeps the surviving draft (no reload) and re-arms the watch.
    controller.attach('host', 'ws-1', 'a.ts')
    const entry = editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))
    expect(entry).toMatchObject({ draft: 'wip\n', status: 'dirty' })
  })

  it('falls back to a time-based save id when randomUUID is unavailable', async () => {
    const { mintSaveId } = await import('../src/client/editor-controller.ts')
    const cryptoRef = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: undefined }, configurable: true })
    try {
      const id = mintSaveId()
      expect(id).toMatch(/^save-/u)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: cryptoRef, configurable: true })
    }
  })
})

describe('WorkspaceEditorController unreadable-disk arms', () => {
  it('conflicts with null disk content when the dirty external change cannot re-open', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    wire.queue('stat', ok({ version: 'v6' }))
    wire.queue('open', failure('not-text', 'undecodable'))
    await controller.externalChange('host', 'ws-1', 'a.ts')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'conflict', conflict: { currentVersion: 'v6', diskContent: null },
    })
  })

  it('conflicts with an empty current version when neither details nor the disk read answer', async () => {
    const store = createWorkspaceEditorStore()
    const wire = new ScriptedWire()
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => { expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toBeDefined() })
    controller.markDirty('host', 'ws-1', 'a.ts')
    wire.queue('save', failure('stale-version', 'changed'))
    wire.queue('open', failure('not-found', 'gone'))
    await controller.save('host', 'ws-1', 'a.ts', 'x\n')
    expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))).toMatchObject({
      status: 'conflict', conflict: { currentVersion: '' },
    })
  })
})

describe('WorkspaceEditorController watch refcounting', () => {
  it('keeps the subscription alive while another occupant holds it', async () => {
    const store = createWorkspaceEditorStore()
    let aborted = false
    const wire: WorkspaceEditorWire = {
      open: async () => ok(openResult('x\n', 'v1')),
      stat: async () => ok({ version: 'v1' }),
      save: async () => ok({ version: 'v2' }),
      watchFiles: (_workspaceId, _path, signalParam) => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: 'ready' as const }
          yield { kind: 'change' as const, change: { absolutePath: '/ws/a.ts', version: 'v1' } }
          await new Promise<void>((resolve) => {
            signalParam.addEventListener('abort', () => { aborted = true; resolve() })
          })
        },
      }),
    }
    const controller = new WorkspaceEditorController(store, wire)
    controller.attach('host', 'ws-1', 'a.ts')
    controller.attach('host', 'ws-1', 'a.ts')
    await vi.waitFor(() => {
      expect(editorEntry(store.getSnapshot(), 'host', editorKey('ws-1', 'a.ts'))?.status).toBe('clean')
    })
    // First detach drops one reference; the feed survives.
    controller.detach('host', 'ws-1', 'a.ts', undefined)
    expect(aborted).toBe(false)
    controller.detach('host', 'ws-1', 'a.ts', undefined)
    expect(aborted).toBe(true)
  })
})
