import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { WorkspaceId } from './workspace.ts'

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

  /** Search regular-file names recursively under fixed scan and result bounds. */
  search(request: RpcRequest<{
    workspaceId: WorkspaceId
    query: string
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
}
