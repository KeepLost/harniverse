// @vitest-environment jsdom
/**
 * Apply-level registration specs: the editor installs its occupant into both
 * preview-document holes once the ui-workspace entries declare them, both
 * registrations land as one transactional pair, and the pair re-installs
 * after the owner declarations collapse and return (the machine-switch
 * shape).
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject, installUnloadGuard } from '../src/client/index.ts'
import { createWorkspaceEditorStore } from '../src/client/stores.ts'

/** Boot the slot registry plus the plugin's service stubs. */
async function bench(options: {
  remote?: unknown
  workspaces?: unknown
  connection?: unknown
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('workspaces', (options.workspaces ?? { watchFiles: undefined }) as never)
  ctx.provide('remote', {} as never)
  ctx.provide('remote.workspaceFileWrite', (options.remote ?? { open: vi.fn(), stat: vi.fn(), save: vi.fn() }) as never)
  ctx.provide('connection', (options.connection ?? {
    target: { getSnapshot: () => ({ kind: 'host' }), subscribe: () => () => {} },
  }) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** Declare the preview-document holes with one root registration. */
function declareHoles(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'workbench': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** The ui-workspace stand-ins: workbench and overlay entries declaring the document holes. */
async function declareOwners(slots: SlotRegistry): Promise<{ workbench: () => void; overlay: () => void }> {
  const workbench = slots.register({
    name: 'workbench',
    children: { 'workbench.preview.document': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  const overlay = slots.register({
    name: 'shell.overlay',
    id: 'workspace-workbench-preview',
    children: { 'shell.overlay.preview.document': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  return { workbench, overlay }
}

describe('ui-workspace-editor apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'locale', 'remote', 'remote.workspaceFileWrite', 'connection'])
  })

  it('installs the occupant pair behind both preview-document declarations', async () => {
    const b = await bench()
    declareHoles(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // No owner declarations yet: nothing installed.
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(0)
    const owners = await declareOwners(b.slots)
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(1)
    expect(b.slots.entries('shell.overlay.preview.document')).toHaveLength(1)
    // Collapsing one declaration removes the transactional pair.
    owners.overlay()
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay.preview.document')).toHaveLength(0)
  })

  it('re-installs the pair after the owner declarations return', async () => {
    const b = await bench()
    declareHoles(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const first = await declareOwners(b.slots)
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(1)
    // A machine switch collapses the owner entries; the editor pair follows
    // and re-installs after the re-declaration.
    first.workbench()
    first.overlay()
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(0)
    await declareOwners(b.slots)
    expect(b.slots.entries('workbench.preview.document')).toHaveLength(1)
    expect(b.slots.entries('shell.overlay.preview.document')).toHaveLength(1)
  })
})

describe('ui-workspace-editor apply wiring', () => {
  it('binds the wire over the Remote namespace and drives the draft account through it', async () => {
    const remote = {
      open: vi.fn(async () => ({ ok: true, value: { content: 'one\n', version: 'v1', bytes: 4, encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF' } })),
      stat: vi.fn(async () => ({ ok: true, value: { version: 'v1' } })),
      save: vi.fn(async () => ({ ok: true, value: { version: 'v2' } })),
    }
    const watch = vi.fn(async function* (): AsyncGenerator<{ kind: 'ready' | 'change'; change?: { absolutePath: string; version: string } }> {
      yield { kind: 'ready' }
      await new Promise<void>(() => {})
    })
    let unloadGuarded = false
    window.addEventListener('beforeunload', (event) => {
      if (event.defaultPrevented) unloadGuarded = true
    })
    const b = await bench({ remote, workspaces: { watchFiles: watch } })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const root = b.slots.register({
      name: 'root',
      children: { workbench: { kind: 'single', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    const owner = b.slots.register({
      name: 'workbench',
      children: { 'workbench.preview.document': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const overlayOwner = b.slots.register({
      name: 'shell.overlay',
      id: 'workspace-workbench-preview',
      children: { 'shell.overlay.preview.document': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const face = (b.slots as unknown as {
      entries(key: string): Array<{ inject?: (...args: never[]) => Record<string, unknown> }>
    }).entries('workbench.preview.document')[0]!.inject!() as {
      machineKey: string
      attach(workspaceId: string, path: string): void
      detach(workspaceId: string, path: string, snapshot: { draft: string; history: unknown } | undefined): void
      markDirty(workspaceId: string, path: string): void
      save(workspaceId: string, path: string, content: string): Promise<void>
      confirmOverwrite(workspaceId: string, path: string, content: string): Promise<void>
      reload(workspaceId: string, path: string): Promise<void>
      hooks: { editorState: { getSnapshot(): { byMachine: Record<string, Record<string, { status: string }>> } } }
    }
    expect(face.machineKey).toBe('host')
    expect(watch).not.toHaveBeenCalled()
    face.attach('ws-9', 'doc.ts')
    await vi.waitFor(() => {
      expect(face.hooks.editorState.getSnapshot().byMachine.host?.['ws-9\u0000doc.ts']).toMatchObject({ status: 'clean' })
    })
    expect(watch).toHaveBeenCalledTimes(1)
    face.markDirty('ws-9', 'doc.ts')
    await face.save('ws-9', 'doc.ts', 'two\n')
    expect(remote.save).toHaveBeenCalledTimes(1)
    // The unload guard fires while any draft is unsaved.
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(unloadGuarded).toBe(false) // the save settled the entry clean again
    face.markDirty('ws-9', 'doc.ts')
    const guarded = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(guarded)
    expect(guarded.defaultPrevented).toBe(true)
    await face.reload('ws-9', 'doc.ts')
    face.markDirty('ws-9', 'doc.ts')
    await face.confirmOverwrite('ws-9', 'doc.ts', 'three\n')
    face.detach('ws-9', 'doc.ts', undefined)
    overlayOwner()
    owner()
    root()
  })
})

describe('unload guard disposal and remote machine keys', () => {
  it('removes the browser listener on dispose', () => {
    const removed: string[] = []
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type: string) => {
      removed.push(type)
    })
    const dispose = installUnloadGuard(createWorkspaceEditorStore())
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    dispose()
    expect(removed).toContain('beforeunload')
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('addresses the remote machine partition when the target is a remote host', async () => {
    const b = await bench({
      connection: { target: { getSnapshot: () => ({ kind: 'remote', id: 'm1' }), subscribe: () => () => {} } },
    })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const root = b.slots.register({
      name: 'root',
      children: { workbench: { kind: 'single', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    const owner = b.slots.register({
      name: 'workbench',
      children: { 'workbench.preview.document': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const overlayOwner = b.slots.register({
      name: 'shell.overlay',
      id: 'workspace-workbench-preview',
      children: { 'shell.overlay.preview.document': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const face = (b.slots as unknown as {
      entries(key: string): Array<{ inject?: (...args: never[]) => Record<string, unknown> }>
    }).entries('workbench.preview.document')[0]!.inject!() as { machineKey: string }
    expect(face.machineKey).toBe('remote:m1')
    overlayOwner()
    owner()
    root()
  })
})
