/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  DirectoryListing, IWorkspaces, SessionId, SnapshotStore, WorkspaceFileEntry, WorkspaceGitCommit,
  WorkspaceGitStatusEntry, WorkspaceId, WorkspaceListState, WorkspaceSearchFilters, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceListState } from './fixtures.ts'
import type { Stabilizer } from './fixtures.ts'

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceListState>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<string, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceListState>(workspaceListState())
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceListState) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - action name (e.g. 'connectWorkspace').
   * @param impl - replacement behavior.
   */
  stub(method: string, impl: (...args: unknown[]) => unknown): void {
    this.stubs.set(method, impl)
  }

  /**
   * Connect a workspace to its reusable/new blank session (recorded). The
   * default resolves the workspace id back as the session id; stub for
   * cross-session flows.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    this.calls.push({ method: 'connectWorkspace', args: [workspaceId] })
    const stub = this.stubs.get('connectWorkspace')
    if (stub !== undefined) return await (stub(workspaceId) as Promise<SessionId>)
    return `session-of-${workspaceId}` as SessionId
  }

  /**
   * New-session flow (recorded; stubbed behavior runs when installed).
   * @param workspaceId - optional explicit workspace target.
   */
  startSession(workspaceId?: WorkspaceId): void {
    this.calls.push({ method: 'startSession', args: [workspaceId] })
    this.stubs.get('startSession')?.(workspaceId)
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return {
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
      sessionIds: [],
    } as unknown as WorkspaceView
  }

  /**
   * Open a path with the host OS default application (recorded; default no-op).
   * @param path - host-resolvable path.
   */
  async openPath(path: string): Promise<void> {
    this.calls.push({ method: 'openPath', args: [path] })
    await (this.stubs.get('openPath')?.(path) as Promise<void> | undefined)
  }

  async listFiles(workspaceId: WorkspaceId, path?: string, signal?: AbortSignal): Promise<{
    path: string
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }> {
    this.calls.push({ method: 'listFiles', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('listFiles')
    if (stub !== undefined) return await stub(workspaceId, path, signal) as {
      path: string
      entries: WorkspaceFileEntry[]
      truncated: boolean
    }
    return { path: path ?? '', entries: [], truncated: false }
  }

  async readFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<{
    path: string
    content: string
    bytes: number
    truncated: boolean
  }> {
    this.calls.push({ method: 'readFile', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('readFile')
    if (stub !== undefined) return await stub(workspaceId, path, signal) as {
      path: string
      content: string
      bytes: number
      truncated: boolean
    }
    return { path, content: '', bytes: 0, truncated: false }
  }

  async searchFiles(
    workspaceId: WorkspaceId,
    query: string,
    filters?: WorkspaceSearchFilters,
    signal?: AbortSignal,
  ): Promise<{
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }> {
    this.calls.push({ method: 'searchFiles', args: [workspaceId, query, filters, signal] })
    const stub = this.stubs.get('searchFiles')
    if (stub !== undefined) return await stub(workspaceId, query, filters, signal) as {
      entries: WorkspaceFileEntry[]
      truncated: boolean
    }
    return { entries: [], truncated: false }
  }

  async readBinaryFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<{
    path: string
    dataBase64: string
    mediaType: string
    bytes: number
  }> {
    this.calls.push({ method: 'readBinaryFile', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('readBinaryFile')
    if (stub !== undefined) return await stub(workspaceId, path, signal) as {
      path: string
      dataBase64: string
      mediaType: string
      bytes: number
    }
    return { path, dataBase64: '', mediaType: 'image/png', bytes: 0 }
  }

  async gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<{
    branch: string | null
    entries: WorkspaceGitStatusEntry[]
    truncated: boolean
  }> {
    this.calls.push({ method: 'gitStatus', args: [workspaceId, signal] })
    const stub = this.stubs.get('gitStatus')
    if (stub !== undefined) return await stub(workspaceId, signal) as {
      branch: string | null
      entries: WorkspaceGitStatusEntry[]
      truncated: boolean
    }
    return { branch: null, entries: [], truncated: false }
  }

  async gitCommits(workspaceId: WorkspaceId, limit?: number, signal?: AbortSignal): Promise<{
    commits: WorkspaceGitCommit[]
    truncated: boolean
  }> {
    this.calls.push({ method: 'gitCommits', args: [workspaceId, limit, signal] })
    const stub = this.stubs.get('gitCommits')
    if (stub !== undefined) return await stub(workspaceId, limit, signal) as {
      commits: WorkspaceGitCommit[]
      truncated: boolean
    }
    return { commits: [], truncated: false }
  }

  async gitDiff(workspaceId: WorkspaceId, path?: string, staged?: boolean, signal?: AbortSignal): Promise<{
    diff: string
    truncated: boolean
  }> {
    this.calls.push({ method: 'gitDiff', args: [workspaceId, path, staged, signal] })
    const stub = this.stubs.get('gitDiff')
    if (stub !== undefined) return await stub(workspaceId, path, staged, signal) as {
      diff: string
      truncated: boolean
    }
    return { diff: '', truncated: false }
  }

  /**
   * Directory picker (recorded). The default cancels (null); stub to select.
   * @returns the picked path, or null.
   */
  async pickDirectory(): Promise<string | null> {
    this.calls.push({ method: 'pickDirectory', args: [] })
    const stub = this.stubs.get('pickDirectory')
    if (stub !== undefined) return await (stub() as Promise<string | null>)
    return null
  }

  /**
   * Browse listing (recorded). The default serves an empty home level; stub
   * to shape a tree.
   * @param path - absolute directory to list; absent lists the home level.
   * @returns the level's listing.
   */
  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    // The signal is recorded and forwarded like the production face passes
    // it to the wire, so cancellation integration tests can observe or
    // reject on a superseded scan.
    this.calls.push({ method: 'listDirectory', args: [path, signal] })
    const stub = this.stubs.get('listDirectory')
    if (stub !== undefined) return await (stub(path, signal) as Promise<DirectoryListing>)
    // The chain runs root-to-target inclusive, per the DirectoryListing
    // contract — a bare root crumb would mislabel the level in browsers
    // driven by this double.
    return {
      path: '/home/test',
      home: '/home/test',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'test', path: '/home/test', hidden: false },
      ],
      entries: [],
      truncated: false,
    }
  }

  /**
   * Browse child creation (recorded). The default joins parent and name.
   * @param path - absolute existing parent directory.
   * @param name - single path segment.
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    this.calls.push({ method: 'createDirectory', args: [path, name] })
    const stub = this.stubs.get('createDirectory')
    if (stub !== undefined) return await (stub(path, name) as Promise<string>)
    return `${path}/${name}`
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return { workspaceId, title, path: `/${title}`, sessionIds: [] } as unknown as WorkspaceView
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [sessionId] } as unknown as WorkspaceView
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /** Remove a session from the recorded archive set. */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unarchiveSession', args: [sessionId] })
    const stub = this.stubs.get('unarchiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = draft.archivedSessionIds.filter(id => id !== sessionId)
    })
  }
}
