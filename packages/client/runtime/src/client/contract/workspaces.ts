/**
 * The outward workspaces-service face — what `ctx.workspaces` exposes to
 * feature packages and the renderer host, and therefore exactly what the
 * test runtime's workspaces double must implement. Wire-pump entry points
 * (handleHostEnvelope/handleConnected/refresh/startInitialSelection) stay on
 * the concrete class. Widening this interface is the explicit act of
 * widening what features may do to the workspaces domain.
 */
import type {
  DirectoryListing, SessionId, WorkspaceFileEntry, WorkspaceGitCommit,
  WorkspaceGitStatusEntry, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

/**
 * Optional glob scoping for one Workspace file search.
 *
 * Both lists are bounded by the Host wire schema; an omitted list means no
 * caller-supplied filter for that direction.
 */
export interface WorkspaceSearchFilters {
  /** Only files matching one of these patterns are returned. */
  include?: string[]
  /** Files and directory subtrees matching one of these patterns are skipped. */
  exclude?: string[]
}

/** The workspaces-service face injected as `ctx.workspaces`. */
export interface IWorkspaces {
  /** The useWorkspaces standard feed (read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<WorkspaceListState>
  /**
   * Connect a Workspace to its reusable or freshly created blank session.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  connectWorkspace(workspaceId: WorkspaceId, agentProfile?: string): Promise<SessionId>
  /**
   * The New Session flow: connect the explicit, current-Session, or recent
   * Workspace and open the resulting session; failures surface on the session
   * list state.
   * @param workspaceId - explicit target; omitted inherits the current
   * Session's Workspace before falling back to the recency projection.
   */
  startSession(workspaceId?: WorkspaceId, agentProfile?: string): void
  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Open the Host's native directory picker.
   * @returns the selected path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  openPath(path: string): Promise<void>
  /** List one lazy-loaded directory level inside a registered Workspace. */
  listFiles(workspaceId: WorkspaceId, path?: string, signal?: AbortSignal): Promise<{
    path: string
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }>
  /**
   * Search regular-file names recursively inside a registered Workspace.
   *
   * `filters.include` and `filters.exclude` are glob lists whose scope follows
   * each pattern's shape: no `/` filters basenames at any depth (`*.py`), a `/`
   * filters the whole relative path, and a trailing `/` covers a directory
   * subtree (`dist/`). An absent or empty exclude list applies the Host's
   * default dependency and build-output skips.
   */
  searchFiles(workspaceId: WorkspaceId, query: string, filters?: WorkspaceSearchFilters, signal?: AbortSignal): Promise<{
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }>
  /** Read one UTF-8 text file inside a registered Workspace. */
  readFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<{
    path: string
    content: string
    bytes: number
    truncated: boolean
  }>
  /** Read one complete, bounded image or PDF inside a registered Workspace. */
  readBinaryFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<{
    path: string
    dataBase64: string
    mediaType: string
    bytes: number
  }>
  /** Read the current read-only Git status for a Workspace. */
  gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<{
    branch: string | null
    entries: WorkspaceGitStatusEntry[]
    truncated: boolean
  }>
  /** Read a bounded read-only Git history for a Workspace. */
  gitCommits(workspaceId: WorkspaceId, limit?: number, signal?: AbortSignal): Promise<{
    commits: WorkspaceGitCommit[]
    truncated: boolean
  }>
  /** Read the current working-tree or staged diff for a Workspace path. */
  gitDiff(workspaceId: WorkspaceId, path?: string, staged?: boolean, signal?: AbortSignal): Promise<{
    diff: string
    truncated: boolean
  }>
  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - the new display title.
   * @returns the updated Workspace view.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace (its sessions fall back to the unaccounted group).
   * @param workspaceId - target workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Move an accounted session within/into a Workspace's ordered list.
   * @param workspaceId - target workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  /**
   * Archive a session into the registry-global set (hidden from grouping
   * surfaces; session log and accounting slot remain). Archiving the current
   * session clears the selection into the New Session view state.
   * @param sessionId - session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /** Remove a Session from the archive set without resuming it. */
  unarchiveSession(sessionId: SessionId): Promise<void>
}
