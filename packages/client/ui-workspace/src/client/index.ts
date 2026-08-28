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
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected, WorkspaceWorkbenchInjected } from './contract/slots.ts'
import { createWorkspaceViewStore, createWorkspaceWorkbenchStore } from './stores.ts'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'
import { WorkspaceWorkbench } from './WorkspaceWorkbench.tsx'
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
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'layout']

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await ctx.sessions.search(query, signal)
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
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    open: (sessionId) => { ctx.sessions.open(sessionId) },
    searchSessions,
    searchResultLimit: ctx.sessions.searchResultLimit,
    renameSession: async (sessionId, title) => {
      // Row → session-face hop: rename is a per-session verb (ISession), not
      // a list-service verb; the binding resolves any listed session.
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId) => {
      ctx.sessions.fork({ sessionId, increaseTitle: true })
        .then((childId) => { ctx.sessions.open(childId) })
        .catch(() => {
          // Fork or child-rename failure keeps the current selection.
        })
    },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId) },
    unarchiveSession: async (sessionId) => { await ctx.workspaces.unarchiveSession(sessionId) },
    openArchive: sessionId => ctx.sessions.openArchive(sessionId),
    loadArchiveOlder: sessionId => ctx.sessions.loadArchiveOlder(sessionId),
    deleteSession: sessionId => ctx.sessions.deleteSession(sessionId),
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: input => ctx.workspaces.create(input),
    hooks: { directoryFlow: browserFlowSource },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      store: createWorkspaceViewStore(),
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
  const workbenchStore = createWorkspaceWorkbenchStore()
  const workbenchInjected = (): WorkspaceWorkbenchInjected => ({
    openWorkbench: () => { ctx.layout.openWorkbench() },
    closeWorkbench: () => { ctx.layout.closeWorkbench() },
    listFiles: (workspaceId, path, signal) => ctx.workspaces.listFiles(workspaceId, path, signal),
    searchFiles: (workspaceId, query, signal) => ctx.workspaces.searchFiles(workspaceId, query, signal),
    readFile: (workspaceId, path, signal) => ctx.workspaces.readFile(workspaceId, path, signal),
    readBinaryFile: (workspaceId, path, signal) => ctx.workspaces.readBinaryFile(workspaceId, path, signal),
    gitStatus: (workspaceId, signal) => ctx.workspaces.gitStatus(workspaceId, signal),
    gitCommits: (workspaceId, limit, signal) => ctx.workspaces.gitCommits(workspaceId, limit, signal),
    gitDiff: (workspaceId, path, staged, signal) => ctx.workspaces.gitDiff(workspaceId, path, staged, signal),
  })
  ctx.slots.inject('workbench', () => ctx.slots.register(
    {
      name: 'workbench',
      store: workbenchStore,
      inject: workbenchInjected,
      locale: NS,
    },
    WorkspaceWorkbench,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
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
