/**
 * Workspace plugin, browser half. WorkspaceBrowser fills the sidebar's
 * `sidebar.workspaces` hole, WorkspacePicker fills
 * `conversation.hero.workspace`, WorkspaceWorkbench fills the shell's
 * root-scoped `workbench` hole, and its button fills the Session-header
 * utility hole. The entries read real Host Workspaces through standard
 * runtime hooks; browser and picker each declare a `single` directory-flow
 * child hole for the composed picker package (see the contract module doc). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected, WorkspacePreviewInjected, WorkspaceWorkbenchInjected } from './contract/slots.ts'
import { createWorkspaceViewStore, createWorkspaceWorkbenchStore } from './stores.ts'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'
import { WorkspaceWorkbench, WorkspaceWorkbenchPreviewOverlay } from './WorkspaceWorkbench.tsx'
import { WorkspaceWorkbenchButton } from './WorkspaceWorkbenchButton.tsx'

export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'layout', 'connection']

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle

  const mount = () => ctx.effect(() => machineSurfaces(ctx, connection), 'ui-workspace: machine surfaces')
  let dispose = mount()
  ctx.effect(() => {
    const unsubscribe = connection.target.subscribe(() => {
      void dispose()
      dispose = mount()
    })
    return () => { unsubscribe(); void dispose() }
  }, 'ui-workspace: target subscription')
}

/** One machine's registrations own its local interaction state and callbacks. */
function* machineSurfaces(ctx: ClientContext, connection: ConnectionHandle): Generator<() => void, void, void> {
  const target = connection.target.getSnapshot()
  const machineKey = target.kind === 'host' ? 'host' : `remote:${target.id}`
  const current = (): void => {
    if (connection.target.getSnapshot() !== target) throw new Error('workspace view belongs to a retired machine')
  }

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    current()
    const result = await ctx.sessions.search(query, signal)
    current()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; unscoped New Session inherits
    // the current Session Workspace before the recent-Workspace fallback.
    startSession: (workspaceId) => { current(); ctx.workspaces.startSession(workspaceId) },
    open: (sessionId) => { current(); ctx.sessions.open(sessionId) },
    searchSessions,
    searchResultLimit: ctx.sessions.searchResultLimit,
    renameSession: async (sessionId, title) => {
      current()
      // Row → session-face hop: rename is a per-session verb (ISession), not
      // a list-service verb; the binding resolves any listed session.
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId) => {
      current()
      ctx.sessions.fork({ sessionId, increaseTitle: true })
        .then((childId) => { current(); ctx.sessions.open(childId) })
        .catch(() => {
          // Fork or child-rename failure keeps the current selection.
        })
    },
    renameWorkspace: async (workspaceId, title) => { current(); await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { current(); await ctx.workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      current()
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    archiveSession: async (sessionId, options) => { current(); await ctx.workspaces.archiveSession(sessionId, options) },
    unarchiveSession: async (sessionId) => { current(); await ctx.workspaces.unarchiveSession(sessionId) },
    pinSession: async (sessionId) => { current(); await ctx.workspaces.pinSession(sessionId) },
    unpinSession: async (sessionId) => { current(); await ctx.workspaces.unpinSession(sessionId) },
    openArchive: (sessionId) => { current(); return ctx.sessions.openArchive(sessionId) },
    loadArchiveOlder: (sessionId) => { current(); return ctx.sessions.loadArchiveOlder(sessionId) },
    deleteSession: (sessionId) => { current(); return ctx.sessions.deleteSession(sessionId) },
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      current()
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: (input) => { current(); return ctx.workspaces.create(input) },
    hooks: { directoryFlow: browserFlowSource },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: (input) => { current(); return ctx.workspaces.create(input) },
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  yield ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.machine': { kind: 'single', scope: 'root' },
      },
      store: createWorkspaceViewStore(machineKey),
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  yield ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
  const workbenchStore = createWorkspaceWorkbenchStore()
  // The Host's native path-open capability rides the connection's
  // description source: true exactly while the connected generation reported
  // canOpenPath, absent before connect and while reconnecting.
  const canOpenPathSource: HostObservable<boolean> = {
    getSnapshot: () => connection.hostDescription.getSnapshot()?.canOpenPath === true,
    subscribe: listener => connection.hostDescription.subscribe(listener),
  }
  const openPath = (path: string): Promise<void> => {
    current()
    return ctx.workspaces.openPath(path)
  }
  // The runtime watch subscription arrives with the Host watch transport;
  // absent here, the workbench falls back to its manual refresh button.
  const boundWatchFiles = ctx.workspaces.watchFiles?.bind(ctx.workspaces)
  const watchFiles: WorkspaceWorkbenchInjected['watchFiles'] = boundWatchFiles === undefined
    ? undefined
    : (workspaceId, path, signal) => {
      current()
      return boundWatchFiles(workspaceId, path, signal)
    }
  const workbenchInjected = (): WorkspaceWorkbenchInjected => ({
    openWorkbench: () => { ctx.layout.openWorkbench() },
    closeWorkbench: () => { ctx.layout.closeWorkbench() },
    listFiles: (workspaceId, path, signal) => { current(); return ctx.workspaces.listFiles(workspaceId, path, signal) },
    searchFiles: (workspaceId, query, filters, signal) => {
      current()
      return ctx.workspaces.searchFiles(workspaceId, query, filters, signal)
    },
    readFile: (workspaceId, path, opts, signal) => { current(); return ctx.workspaces.readFile(workspaceId, path, opts, signal) },
    readBinaryFile: (workspaceId, path, signal) => { current(); return ctx.workspaces.readBinaryFile(workspaceId, path, signal) },
    gitStatus: (workspaceId, signal) => { current(); return ctx.workspaces.gitStatus(workspaceId, signal) },
    gitCommits: (workspaceId, limit, signal) => { current(); return ctx.workspaces.gitCommits(workspaceId, limit, signal) },
    gitDiff: (workspaceId, path, staged, signal) => { current(); return ctx.workspaces.gitDiff(workspaceId, path, staged, signal) },
    openPath,
    ...(watchFiles === undefined ? {} : { watchFiles }),
    hooks: { canOpenPath: canOpenPathSource },
  })
  yield ctx.slots.inject('workbench', () => ctx.slots.register(
    {
      name: 'workbench',
      store: workbenchStore,
      inject: workbenchInjected,
      locale: NS,
      // Contributed sections (browser, terminal, …): one tab beside the
      // shipped files/changes/search tabs, one body inside the tabpanel.
      children: {
        'workbench.section.tab': { kind: 'list', scope: 'root' },
        'workbench.section.panel': { kind: 'list', scope: 'root' },
      },
    },
    WorkspaceWorkbench,
  ))
  // The preview surface is a second registration over the SAME store handle:
  // it lives in the frame-wide overlay layer so it can slide over the
  // conversation, which the workbench column (overflow-clipped) cannot do.
  // It carries only the native open-path action and its capability.
  const previewInjected = (): WorkspacePreviewInjected => ({
    openPath,
    readFile: (workspaceId, path, opts, signal) => { current(); return ctx.workspaces.readFile(workspaceId, path, opts, signal) },
    hooks: { canOpenPath: canOpenPathSource },
  })
  yield ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'workspace-workbench-preview',
      order: 10,
      store: workbenchStore,
      inject: previewInjected,
      locale: NS,
    },
    WorkspaceWorkbenchPreviewOverlay,
  ))
  yield ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'workspace-workbench',
      order: 20,
      locale: NS,
      inject: workbenchInjected,
    },
    WorkspaceWorkbenchButton,
  ))
}
