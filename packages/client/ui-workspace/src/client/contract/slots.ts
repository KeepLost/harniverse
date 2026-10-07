/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog shared with the browser).
 *
 * Each registration also declares one **directory-flow hole** (`single`
 * kind): the slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * Two holes exist because the two menu surfaces are independent slot entries
 * and a hole has exactly one declaring entry — they carry the same owner
 * contract and the same occupant.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  ConversationSnapshot, RpcResult, SessionId, SessionSearchResultItem, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { IWorkspaces, WorkspaceFileWatch } from '@deepseek-ai/dsh-client-runtime/client'
import type { createWorkspaceViewStore, createWorkspaceWorkbenchStore } from '../stores.ts'

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Active machine label and navigation, above the workspace list. */
    'sidebar.workspaces.machine': { kind: 'single'; scope: 'root'; owner: { wide: boolean } }
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /**
     * Preview-document hole inside the drawer placement's document preview
     * (declared by the workbench entry). Occupied by the composed editor
     * plugin; an empty hole keeps the read-only preview, byte-identical to
     * the pre-editor surface.
     */
    'workbench.preview.document': { kind: 'single'; scope: 'root'; owner: PreviewDocumentOwnerProps }
    /**
     * Preview-document hole inside the overlay placement's document preview
     * (declared by the shell.overlay preview entry). Same owner contract and
     * occupant as the drawer hole.
     */
    'shell.overlay.preview.document': { kind: 'single'; scope: 'root'; owner: PreviewDocumentOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Owner share of the two preview-document holes: the complete conversation
 * between the read-only preview and a composed editing occupant. An editable
 * document shows its rendered preview by default; the owner mounts the
 * occupant only while the document's Preview / Edit toggle is on Edit. The
 * occupant owns the document's draft, its save lifecycle, and its conflict
 * handling; the owner keeps rendering the read-only families for tabs outside
 * the editable set and confirms before closing a dirty document, including one
 * whose occupant is unmounted in Preview mode.
 */
export interface PreviewDocumentOwnerProps {
  /** Workspace owning the document. */
  workspaceId: WorkspaceId
  /** Workspace-relative document path. */
  path: string
  /** Preview family of the document; only editable families receive an occupant. */
  kind: 'markdown' | 'html' | 'code' | 'text' | 'csv' | 'tsv'
  /** Language id the preview derived for the document, when it found one. */
  language?: string
  /** Whether this placement is the visible one. */
  active: boolean
  /** Which placement renders the occupant. */
  placement: 'overlay' | 'in-column'
  /**
   * Present when preview-level facts already rule editing out; the occupant
   * renders its read-only fallback notice instead of an editable surface. The
   * shipped workbench never mounts the occupant for such a document (it keeps
   * Edit disabled), so it does not send this.
   */
  readOnlyFallback?: { reason: string }
  /**
   * Report the document's dirty fact; the owner confirms before closing a
   * dirty document. Unmounting the occupant does not retract the fact: it
   * stands while the occupant's draft account still holds unsaved edits.
   */
  onDirtyChange(dirty: boolean): void
  /**
   * The occupant saved the document (a version-checked save or a confirmed
   * conflict overwrite landed); the owner re-reads the file so the rendered
   * preview shows the saved text.
   */
  onSaved?(): void
  /** The occupant requests the owner to close the preview after its own Escape handling. */
  onRequestClose(): void
}

/** The two preview-document holes; the editor plugin registers one component into both. */
export type PreviewDocumentSlotName =
  | 'workbench.preview.document'
  | 'shell.overlay.preview.document'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = {
  /** Selector hook over this surface's directory-flow occupancy. */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
}

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = DirectoryPickingInjected & {
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session and
   * open it; without an explicit workspace, inherit the current Session
   * Workspace, then the recent Workspace, or clear into the New Session view.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /**
   * Search current visible conversation messages. The Host fixes the result
   * bound; `hasMore` means the query needs narrowing.
   */
  searchSessions: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** Maximum number of merged rows rendered for one search. */
  searchResultLimit: number
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a Workspace in the durable registry display order.
   * Omitted anchor appends to the end.
   */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /**
   * Archive a Session into the registry-global set: hidden from grouping
   * surfaces, log and accounting slot retained. Archiving the current
   * session clears the selection into the New Session view state. Without
   * options a session with running work rejects with the workspace
   * service's `SessionArchiveActiveError` carrying the host-reported
   * activities; `stopActivity` archives first and stops the reported work
   * afterwards. Archiving drops the session's pin.
   */
  archiveSession: (sessionId: SessionId, options?: { stopActivity?: boolean }) => Promise<void>
  /** Remove a Session from the archive set without resuming it. */
  unarchiveSession: (sessionId: SessionId) => Promise<void>
  /** Prepend one session to the registry-global pin set (pinned rows lead their section). */
  pinSession: (sessionId: SessionId) => Promise<void>
  /** Remove one session from the registry-global pin set. */
  unpinSession: (sessionId: SessionId) => Promise<void>
  /** Open one archived Session for a read-only history preview. */
  openArchive: (sessionId: SessionId) => Promise<RpcResult<{ snapshot: ConversationSnapshot }>>
  /** Load one older page for an already-open archived preview. */
  loadArchiveOlder: (sessionId: SessionId) => Promise<RpcResult<{ snapshot: ConversationSnapshot }>>
  /** Permanently delete one Session through the Host deletion transaction. */
  deleteSession: (sessionId: SessionId) => Promise<RpcResult<{ deleted: true; attachmentsRetained: true }>>
  /**
   * Reorder a session inside its Workspace account (DOM-insertBefore
   * semantics: omitted anchor appends to the end). The view refreshes from
   * the Host response/changed frame; failures leave the order unchanged.
   */
  insertSessionBefore: (workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId) => Promise<void>
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/** Full browser props: shell owner share + viewing store + injected actions + the locale seat. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.machine'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The two picker holes (blank-session hero / New-Session view)
 * share one owner currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>

/** Read-only Workspace workbench callbacks supplied by the apply world. */
export type WorkspaceWorkbenchInjected = {
  /** Open the workbench without starting an inspection request. */
  openWorkbench: () => void
  /** Close the workbench while retaining its Workspace-local viewing state. */
  closeWorkbench: () => void
  listFiles: IWorkspaces['listFiles']
  searchFiles: IWorkspaces['searchFiles']
  readFile: IWorkspaces['readFile']
  readBinaryFile: IWorkspaces['readBinaryFile']
  gitStatus: IWorkspaces['gitStatus']
  gitCommits: IWorkspaces['gitCommits']
  gitDiff: IWorkspaces['gitDiff']
  /**
   * Open a Host-resolved path with the operating system's default
   * application; `resolveWorkspacePath` turns a Workspace-relative tree path
   * into the spelling this accepts.
   */
  openPath: IWorkspaces['openPath']
  /**
   * The runtime's directory watch subscription, when the Host watch
   * transport has shipped; absent means watch-driven refresh is unavailable
   * and the manual refresh button is the only relist trigger.
   */
  watchFiles?: WorkspaceFileWatch
  /**
   * Reserved reactive compartment: true while the connected Host can open
   * paths with a native application (its description reports
   * `canOpenPath`), and whether the drawer placement's preview-document
   * hole has an occupant.
   */
  hooks: {
    /** The Host's native path-open capability. */
    canOpenPath: HostObservable<boolean>
    /** Occupancy of the `workbench.preview.document` hole. */
    previewDocumentOccupied: HostObservable<boolean>
  }
}

/** Full top-level workbench props: session runtime, shared store, callbacks, and locale. */
export type WorkspaceWorkbenchProps =
  PropsRuntime<'workbench'>
  & PropsRenderSlots<'workbench.section.tab' | 'workbench.section.panel' | 'workbench.preview.document'>
  & PropsStore<ReturnType<typeof createWorkspaceWorkbenchStore>>
  & InjectFace<WorkspaceWorkbenchInjected>
  & PropsLocale<'workspace'>

/**
 * Preview-surface callbacks supplied by the apply world: the native
 * open-path action and its capability, shared with the workbench face.
 */
export type WorkspacePreviewInjected = {
  openPath: IWorkspaces['openPath']
  /** Text re-read with an explicit encoding (the "reopen with encoding" action). */
  readFile: IWorkspaces['readFile']
  /** Reserved reactive compartment: see {@link WorkspaceWorkbenchInjected}. */
  hooks: {
    /** The Host's native path-open capability. */
    canOpenPath: HostObservable<boolean>
    /** Occupancy of the `shell.overlay.preview.document` hole. */
    overlayDocumentOccupied: HostObservable<boolean>
  }
}

/**
 * Props of the preview companion registered into the shell's overlay layer.
 *
 * The surface needs no inspection callbacks: the workbench performs every read
 * and the two registrations share one store handle, so this side only renders
 * what the shared account already holds.
 */
export type WorkspacePreviewOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsRenderSlots<'shell.overlay.preview.document'>
  & PropsStore<ReturnType<typeof createWorkspaceWorkbenchStore>>
  & InjectFace<WorkspacePreviewInjected>
  & PropsLocale<'workspace'>
