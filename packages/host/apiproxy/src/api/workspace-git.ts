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
  /** Full parent hashes, first parent first; empty for a root commit. */
  parents: string[]
  /** Decorated refs pointing at the commit. */
  refs: WorkspaceGitCommitRef[]
}

/** One decorated ref pointing at a commit. */
export interface WorkspaceGitCommitRef {
  kind: 'head' | 'local' | 'remote' | 'tag' | 'other'
  name: string
  current: boolean
}

/** One changed path of a commit's first-parent diff. */
export interface WorkspaceGitCommitFile {
  path: string
  previousPath?: string
  status: 'A' | 'C' | 'D' | 'M' | 'R' | 'T'
}

/** Read-only Git inspection scoped to paths beneath one registered workspace. */
export interface WorkspaceGitApi {
  status(request: RpcRequest<{ workspaceId: WorkspaceId }>, signal: AbortSignal): Promise<RpcResponse<{
    branch: string | null
    /** Short upstream name; null when the branch tracks nothing or HEAD is detached. */
    upstream: string | null
    /** Commits ahead of the upstream; null when there is no upstream. */
    ahead: number | null
    /** Commits behind the upstream; null when there is no upstream. */
    behind: number | null
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

  commitFiles(request: RpcRequest<{
    workspaceId: WorkspaceId
    /** Full 40-character hex SHA of the commit. */
    hash: string
  }>, signal: AbortSignal): Promise<RpcResponse<{
    files: WorkspaceGitCommitFile[]
    truncated: boolean
  }>>

  commitDiff(request: RpcRequest<{
    workspaceId: WorkspaceId
    /** Full 40-character hex SHA of the commit. */
    hash: string
    /** Workspace-relative path restriction. */
    path: string
  }>, signal: AbortSignal): Promise<RpcResponse<{
    diff: string
    truncated: boolean
  }>>
}
