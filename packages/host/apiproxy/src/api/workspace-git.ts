import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { WorkspaceId } from './workspace.ts'

/** One porcelain Git status row with index and working-tree columns kept independent. */
export interface WorkspaceGitStatusEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
  originalPath?: string
}

/** One bounded Git history row. */
export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
}

/** Read-only Git inspection scoped to paths beneath one registered workspace. */
export interface WorkspaceGitApi {
  status(request: RpcRequest<{ workspaceId: WorkspaceId }>, signal: AbortSignal): Promise<RpcResponse<{
    branch: string | null
    entries: WorkspaceGitStatusEntry[]
    truncated: boolean
  }>>

  commits(request: RpcRequest<{
    workspaceId: WorkspaceId
    /** Defaults to 50 and cannot exceed 100. */
    limit?: number
  }>, signal: AbortSignal): Promise<RpcResponse<{
    commits: WorkspaceGitCommit[]
    truncated: boolean
  }>>

  diff(request: RpcRequest<{
    workspaceId: WorkspaceId
    /** Optional workspace-relative pathspec. */
    path?: string
    /** Read the index-to-HEAD diff instead of the working-tree diff. */
    staged?: boolean
  }>, signal: AbortSignal): Promise<RpcResponse<{
    diff: string
    truncated: boolean
  }>>
}
