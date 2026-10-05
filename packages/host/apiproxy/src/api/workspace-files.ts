import type { RpcError, RpcRequest, RpcResponse } from './rpc.ts'
import type { WorkspaceId } from './workspace.ts'

/** Maximum glob patterns accepted in one Workspace search filter direction. */
export const WORKSPACE_GLOB_LIST_LIMIT = 20
/** Maximum characters accepted in one Workspace search glob. */
export const WORKSPACE_GLOB_PATTERN_LIMIT = 200

/** One immediate child of a workspace directory. Symlinks are listed but never traversed by listing. */
export interface WorkspaceFileEntry {
  name: string
  /** Workspace-relative path using forward slashes. */
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
}

/** Read-only, workspace-id-scoped filesystem inspection. */
export interface WorkspaceFilesApi {
  /** List one directory without name-based exclusions, under a fixed Host entry bound. */
  list(request: RpcRequest<{
    workspaceId: WorkspaceId
    /** Workspace-relative directory; omitted addresses the workspace root. */
    path?: string
  }>, signal: AbortSignal): Promise<RpcResponse<{
    path: string
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }>>

  /**
   * Search regular-file names recursively under fixed scan and result bounds,
   * optionally scoped by glob patterns.
   *
   * Pattern scope follows the pattern's shape: no `/` filters basenames at any
   * depth (`*.py`), a `/` filters the whole relative path (`src/**` + `/*.ts`),
   * and a trailing `/` covers a directory subtree (`dist/`). An absent or empty
   * exclude list applies the Host's default dependency and build-output skips.
   */
  search(request: RpcRequest<{
    workspaceId: WorkspaceId
    query: string
    include?: string[]
    exclude?: string[]
  }>, signal: AbortSignal): Promise<RpcResponse<{
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }>>

  /** Read a fixed-size UTF-8 prefix of one canonically contained regular file. */
  read(request: RpcRequest<{
    workspaceId: WorkspaceId
    path: string
  }>, signal: AbortSignal): Promise<RpcResponse<{
    path: string
    content: string
    /** Full file size at the read handle. */
    bytes: number
    truncated: boolean
  }>>

  /** Read one complete, bounded image or PDF as base64 for a browser object URL. */
  readBinary(request: RpcRequest<{
    workspaceId: WorkspaceId
    path: string
  }>, signal: AbortSignal): Promise<RpcResponse<{
    path: string
    dataBase64: string
    mediaType: string
    bytes: number
  }>>

  /**
   * Watch one workspace file or directory and stream its invalidations. The
   * first frame is `ready` once the watcher is active; each later `change`
   * frame carries the target's current metadata — its freshness `version`
   * when it exists, `absent: true` when it was observed gone. A missing
   * target is legal: the host watches its nearest existing ancestor, so the
   * target's creation still fires a change frame. Event bursts are
   * coalesced into one trailing frame per window. Open failures and
   * mid-stream failures arrive as the shared `stream/error` closer frame;
   * concurrent watches per workspace are capped (`workspace-watch-limit-reached`).
   */
  watchFiles(
    request: RpcRequest<{
      workspaceId: WorkspaceId
      /** Workspace-relative target; omitted addresses the workspace root. */
      path?: string
    }>,
    signal: AbortSignal,
  ): AsyncIterable<RpcRequest<WorkspaceFileWatchFrame>>
}

/**
 * Current target metadata after one observed invalidation. File consumers may
 * ignore an already known `version`; directory consumers relist on every frame
 * because a child can change without changing the directory version.
 */
export type WorkspaceFileChange =
  | {
    /** Absolute target path in the host's path vocabulary. */
    absolutePath: string
    /** Opaque freshness token from the current stat; never parsed. */
    version: string
  }
  | {
    /** Absolute target path in the host's path vocabulary. */
    absolutePath: string
    /** The target was observed to be gone. */
    absent: true
  }

/**
 * One workspace file watch stream's frames: `ready` confirms the target
 * watcher is active, `change` frames follow for coalesced invalidations, and
 * the shared `stream/error` member closes a failed stream — the same closer
 * every other stream family appends.
 */
export type WorkspaceFileWatchFrame =
  | { kind: 'ready' }
  | { kind: 'change'; change: WorkspaceFileChange }
  | { type: 'stream/error'; error: RpcError }
