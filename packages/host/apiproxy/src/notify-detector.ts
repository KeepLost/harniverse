/**
 * Central notification occurrence detector. The page-presence router feeds
 * every session occurrence the host already observes — durable turn
 * settlements, requested approvals and questions, background-job terminal
 * edges, the goal projection's `blocked` entry, and live agent errors —
 * through one shared fold, mirroring the client sound watcher's detection
 * rules: turn settlements read the durable `turn/end` reason (aborted /
 * max-tokens / interrupted turns stay silent), requested approvals and
 * questions ring once per rpcId, jobs ring on the running→terminal edge, and
 * the goal projection rings only on the entry into `blocked`. Detection is
 * global (one fold over the live frame sources, never the per-stream mux
 * replay); routing to the owning page happens at the delivery sink.
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobView } from './api/jobs.ts'

/** One detected occurrence handed to the delivery sink. */
export interface NotifyOccurrence {
  readonly kind: 'approval' | 'question' | 'completion' | 'failure' | 'goal-blocked'
  readonly sessionId: SessionId
  readonly sourceKey: string
  readonly questions?: AskUserQuestionItem[]
}

/** Minimal job view shape the terminal-edge fold reads. */
interface DetectorJobView {
  readonly id: string
  readonly status: JobView['status']
}

/**
 * One shared fold over the host's live notification sources; the delivery
 * sink owns page routing and session-visibility fences.
 */
export class NotifyDetector {
  /**
   * @param sink - receives every detected occurrence; routing and visibility
   * fences belong to the sink, not the detector.
   */
  constructor(private readonly sink: (occurrence: NotifyOccurrence) => void) {}

  private readonly seenPending = new Map<string, SessionId>()
  private readonly jobStatus = new Map<string, JobView['status']>()
  private readonly goalPhase = new Map<string, string>()

  /**
   * Fold one durable session event; only `turn/end` settles into an occurrence.
   * @param sessionId - session the event belongs to.
   * @param event - the durable event.
   */
  sessionEvent(sessionId: SessionId, event: SessionEvent): void {
    if (event.type !== 'turn/end') return
    const reason = event.data.reason
    if (reason.kind === 'completed') {
      this.sink({ kind: 'completion', sessionId, sourceKey: `session:${sessionId}` })
    } else if (reason.kind === 'error') {
      this.sink({ kind: 'failure', sessionId, sourceKey: `session:${sessionId}:failure` })
    }
  }

  /**
   * Fold one live approval request; one occurrence per rpcId until it resolves.
   * @param sessionId - session the approval belongs to.
   * @param rpcId - the approval frame's answerable rpcId.
   */
  approvalRequested(sessionId: SessionId, rpcId: string): void {
    const key = `approval:${rpcId}`
    if (this.seenPending.has(key)) return
    this.seenPending.set(key, sessionId)
    this.sink({ kind: 'approval', sessionId, sourceKey: `pending:${sessionId}:approval` })
  }

  /**
   * Fold one live question request; one occurrence per rpcId until it resolves.
   * @param sessionId - session the question belongs to.
   * @param rpcId - the question frame's answerable rpcId.
   * @param questions - the frame's question items, carried for local classification.
   */
  questionRequested(sessionId: SessionId, rpcId: string, questions: readonly AskUserQuestionItem[]): void {
    const key = `question:${rpcId}`
    if (this.seenPending.has(key)) return
    this.seenPending.set(key, sessionId)
    this.sink({ kind: 'question', sessionId, sourceKey: `pending:${sessionId}:question`, questions: [...questions] })
  }

  /**
   * Mark one pending request resolved; its rpcId may ring again on a new request.
   * @param kind - which pending family resolved.
   * @param rpcId - the frame's answerable rpcId.
   */
  pendingResolved(kind: 'approval' | 'question', rpcId: string): void {
    this.seenPending.delete(`${kind}:${rpcId}`)
  }

  /**
   * Fold one complete jobs snapshot; ring running/stopping → terminal edges.
   * @param sessionId - session the jobs belong to.
   * @param jobs - the whole live set for that session.
   */
  jobsSnapshot(sessionId: SessionId, jobs: readonly DetectorJobView[]): void {
    const seen = new Set<string>()
    for (const job of jobs) {
      const key = `${sessionId}:${job.id}`
      seen.add(key)
      const previous = this.jobStatus.get(key)
      const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
      if ((previous === 'running' || previous === 'stopping') && terminal) {
        if (job.status === 'failed') {
          this.sink({ kind: 'failure', sessionId, sourceKey: `job:${key}` })
        } else if (job.status !== 'killed') {
          this.sink({ kind: 'completion', sessionId, sourceKey: `job:${key}` })
        }
      }
      this.jobStatus.set(key, job.status)
    }
    for (const key of this.jobStatus.keys()) {
      if (key.startsWith(`${sessionId}:`) && !seen.has(key)) this.jobStatus.delete(key)
    }
  }

  /**
   * Fold one goal projection change; ring only the entry into `blocked`.
   * @param sessionId - session the projection belongs to.
   * @param value - the projection unit's finished value.
   */
  goalProjection(sessionId: SessionId, value: unknown): void {
    const phase = phaseOf(value)
    const previous = this.goalPhase.get(sessionId)
    this.goalPhase.set(sessionId, phase ?? '')
    if (phase === 'blocked' && previous !== 'blocked') {
      this.sink({ kind: 'goal-blocked', sessionId, sourceKey: `goal:${sessionId}` })
    }
  }

  /**
   * Drop one disposed session's edge state (bounded memory).
   * @param sessionId - the session that left the host.
   */
  sessionDisposed(sessionId: SessionId): void {
    for (const key of this.jobStatus.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.jobStatus.delete(key)
    }
    this.goalPhase.delete(sessionId)
  }

  /**
   * Fold one live agent failure with no turn position.
   * @param sessionId - the failed session.
   */
  agentError(sessionId: SessionId): void {
    this.sink({ kind: 'failure', sessionId, sourceKey: `session:${sessionId}:failure` })
  }
}

/** Read the goal phase off one projection value. */
function phaseOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const phase = (value as { phase?: unknown }).phase
  return typeof phase === 'string' ? phase : undefined
}
