import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { WorkspaceWorkbench, WorkspaceWorkbenchPreviewOverlay } from '../src/client/WorkspaceWorkbench.tsx'
import type { WorkspaceWorkbenchInjected } from '../src/client/contract/slots.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const startSession = vi.fn()
  const rename = vi.fn(async () => ({}))
  const insertSessionBefore = vi.fn(async () => ({}))
  const open = vi.fn()
  const clear = vi.fn()
  const search = vi.fn(async () => ({
    ok: true as const,
    value: { items: [{ sessionId: 'session' as never, snippet: 'match' }], hasMore: false },
  }))
  const renameSession = vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } }))
  const binding = vi.fn(() => ({ session: { rename: renameSession } }))
  const fork = vi.fn(async () => 'forked' as never)
  const openWorkbench = vi.fn()
  const closeWorkbench = vi.fn()
  const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }))
  const searchFiles = vi.fn(async () => ({ entries: [], truncated: false }))
  const readFile = vi.fn(async (_workspaceId, path: string) => ({ path, content: '', bytes: 0, truncated: false }))
  const readBinaryFile = vi.fn(async (_workspaceId, path: string) => ({ path, dataBase64: '', mediaType: 'image/png', bytes: 0 }))
  const gitStatus = vi.fn(async () => ({ branch: null, entries: [], truncated: false }))
  const gitCommits = vi.fn(async () => ({ commits: [], truncated: false }))
  const gitDiff = vi.fn(async () => ({ diff: '', truncated: false }))
  ctx.provide('workspaces', {
    create, startSession, rename, insertSessionBefore,
    listFiles, searchFiles, readFile, readBinaryFile, gitStatus, gitCommits, gitDiff,
  } as never)
  ctx.provide('sessions', { open, clear, search, searchResultLimit: 20, binding, fork } as never)
  ctx.provide('layout', { openWorkbench, closeWorkbench } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, create, startSession, rename,
    insertSessionBefore, open, clear, search, renameSession, binding, fork,
    openWorkbench, closeWorkbench, listFiles, searchFiles, readFile, readBinaryFile, gitStatus, gitCommits, gitDiff,
  }
}

type HoleName =
  | 'sidebar.workspaces'
  | 'conversation.hero.workspace'
  | 'conversation.session.header.utilities'
  | 'workbench'
  | 'shell.overlay'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, {
    kind: name === 'conversation.session.header.utilities' || name === 'shell.overlay' ? 'list' : 'single',
    scope: name === 'conversation.session.header.utilities' ? 'session' : 'root',
  }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale', 'layout'])
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.workspaces')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('session.new')).toBe('新会话')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    // Both arms delegate to the runtime's shared New Session action.
    browser.startSession('ws' as never)
    expect(b.startSession).toHaveBeenCalledWith('ws')
    browser.startSession()
    expect(b.startSession).toHaveBeenLastCalledWith(undefined)
    browser.open('session' as never)
    expect(b.open).toHaveBeenCalledWith('session')
    const signal = new AbortController().signal
    await expect(browser.searchSessions('match', signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
    expect(b.search).toHaveBeenCalledWith('match', signal)
    expect(browser.searchResultLimit).toBe(20)
    await browser.renameSession('session' as never, 'renamed session')
    expect(b.binding).toHaveBeenCalledWith('session')
    expect(b.renameSession).toHaveBeenCalledWith('renamed session')
    browser.forkSession('session' as never)
    await vi.waitFor(() => {
      expect(b.open).toHaveBeenCalledWith('forked')
    })
    expect(b.fork).toHaveBeenCalledWith({ sessionId: 'session', increaseTitle: true })
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.insertSessionBefore('ws' as never, 's1' as never, 's2' as never)
    expect(b.insertSessionBefore).toHaveBeenCalledWith('ws', 's1', 's2')
    await browser.createWorkspace({ path: '/tmp/browser-project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/browser-project' })

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('registers one top-level workbench and routes its authenticated read callbacks', async () => {
    const b = await bench()
    declare(b.slots, 'workbench', 'shell.overlay', 'conversation.session.header.utilities')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    expect(b.slots.entries('workbench')[0]!.component).toBe(WorkspaceWorkbench)
    const injected = (b.slots.entries('workbench')[0]!.inject as () => WorkspaceWorkbenchInjected)()
    const signal = new AbortController().signal
    await injected.listFiles('ws' as never, 'src', signal)
    await injected.searchFiles('ws' as never, 'needle', { include: ['*.ts'], exclude: ['dist/'] }, signal)
    await injected.readFile('ws' as never, 'README.md', signal)
    await injected.readBinaryFile('ws' as never, 'pixel.png', signal)
    await injected.gitStatus('ws' as never, signal)
    await injected.gitCommits('ws' as never, 10, signal)
    await injected.gitDiff('ws' as never, 'README.md', true, signal)
    injected.openWorkbench()
    injected.closeWorkbench()

    expect(b.listFiles).toHaveBeenCalledWith('ws', 'src', signal)
    expect(b.searchFiles).toHaveBeenCalledWith('ws', 'needle', { include: ['*.ts'], exclude: ['dist/'] }, signal)
    expect(b.slots.entries('shell.overlay')[0]!.component).toBe(WorkspaceWorkbenchPreviewOverlay)
    expect(b.readFile).toHaveBeenCalledWith('ws', 'README.md', signal)
    expect(b.readBinaryFile).toHaveBeenCalledWith('ws', 'pixel.png', signal)
    expect(b.gitStatus).toHaveBeenCalledWith('ws', signal)
    expect(b.gitCommits).toHaveBeenCalledWith('ws', 10, signal)
    expect(b.gitDiff).toHaveBeenCalledWith('ws', 'README.md', true, signal)
    expect(b.openWorkbench).toHaveBeenCalledOnce()
    expect(b.closeWorkbench).toHaveBeenCalledOnce()
  })

  it('declares the two directory-flow holes and reports their occupancy per surface', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child holes (declaration = render authorization).
    expect(b.slots.spec('sidebar.workspaces.directoryFlow')).toMatchObject({ kind: 'single' })
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips exactly its own surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'sidebar.workspaces.directoryFlow' } as never, () => null)
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(true)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('rejects the browser search callback on a runtime business error', async () => {
    const b = await bench()
    b.search.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'internal', message: 'index unavailable', details: {} },
    }) as never)
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    await expect(browser.searchSessions('needle', new AbortController().signal))
      .rejects.toThrow('index unavailable')
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'workbench', 'shell.overlay', 'conversation.session.header.utilities')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    expect(b.slots.entries('workbench')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })
})
