/**
 * Browser-safe background-job domain contract. The registry's live records
 * never cross the wire; a view is the subset a human list needs, minted fresh
 * per push.
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface.
 */
export interface JobView {
  /** Stable operation lookup identity derived from the registry job id. */
  operationId?: string
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
}

/** Window returned by one non-consuming output-ring read. */
export interface JobFollowView {
  /** Ring bytes from the requested offset (or the ring's start, whichever is later). */
  text: string
  /** Offset to pass next time; advances even when the ring truncated early bytes. */
  nextOffsetBytes: number
  /** True when the requested offset fell before the ring's retained start. */
  truncated: boolean
  /** Total bytes the producer has emitted into the ring so far. */
  totalBytes: number
  /** The job's lifecycle state at read time. */
  status: JobView['status']
}

/**
 * Human-facing follow/stop surface over the live registry. Both methods
 * authorize through the session's live Agent: `follow` is the read-only ring
 * window a viewer polls, and `kill` is the human stop that leaves the owner's
 * completion notice intact.
 */
export interface JobsApi {
  /**
   * Read one job's retained output ring without consuming the model's output
   * cursor or marking the job reported.
   */
  follow(request: RpcRequest<{
    sessionId: SessionId
    jobId: JobId
    /** Ring offset to read from; omitted (or 0) starts at the ring's start. */
    offsetBytes?: number
  }>): Promise<RpcResponse<JobFollowView>>

  /**
   * Request a human stop: the job flips to `stopping` while the ordinary
   * completion notice keeps flowing (the killer does not claim the report).
   */
  kill(request: RpcRequest<{
    sessionId: SessionId
    jobId: JobId
  }>): Promise<RpcResponse<{ result: 'requested' | 'already-finished' }>>
}
