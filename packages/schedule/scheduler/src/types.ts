/**
 * Scheduler vocabulary: the durable record shape, the rule grammar, and the
 * log-only `schedule/dispatch` session event that marks one delivery.
 * @module @deepseek-ai/dsh-scheduler/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** When one schedule fires. */
export type SchedulerRule =
  | { readonly kind: 'after'; readonly delayMs: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly intervalMs: number; readonly anchor: string }

/** Which session a schedule delivers into. */
export type ScheduleTargetKind = 'current' | 'job'

/** Whether the target surface is reset before the prompt is delivered. */
export type ScheduleContextMode = 'fresh' | 'continue'

/** Lifecycle of one schedule record. */
export type ScheduleStatus = 'active' | 'paused' | 'done'

/** Who created one schedule. */
export interface ScheduleCreator {
  readonly kind: 'user' | 'model'
  readonly sessionId: SessionId
}

/** Server-derived provenance for the current prompt revision. */
export interface SchedulePromptEdit {
  readonly version: number
  readonly prompt: string
  readonly editedBy: ScheduleCreator
  readonly editedAt: number
}

/** Durable result of one scheduled delivery attempt. */
export interface ScheduleRun {
  readonly id: string
  readonly scheduleId: string
  readonly ownerSessionId: SessionId
  readonly targetSessionId: SessionId
  readonly dueAt: number
  readonly attemptedAt: number
  readonly promptRevision?: number
  readonly status: 'succeeded' | 'failed'
  readonly error?: string
}

/** One durable scheduled prompt. */
export interface ScheduleRecord {
  readonly id: string
  readonly prompt: string
  readonly rule: SchedulerRule
  readonly target: { readonly kind: ScheduleTargetKind }
  readonly contextMode: ScheduleContextMode
  readonly createdBy: ScheduleCreator
  readonly status: ScheduleStatus
  readonly jobSessionId?: SessionId
  readonly createdAt: number
  /** Monotonic prompt revision, including the creation revision. */
  readonly promptRevision?: number
  /** The latest prompt mutation, if this record predates provenance support. */
  readonly lastPromptEdit?: SchedulePromptEdit
  readonly nextDue?: number
  readonly lastRunAt?: number
  readonly lastDue?: number
  readonly lastError?: string
}

/** Editable fields accepted by {@link SchedulerService.update}. */
export interface ScheduleUpdate {
  readonly prompt?: string
  readonly status?: ScheduleStatus
}

/** Result of one dispatch attempt against a due schedule. */
export interface ScheduleDispatchOutcome {
  readonly scheduleId: string
  readonly dispatched: boolean
  readonly dueAt: number
  readonly sessionId: SessionId
  readonly error?: string
}

/** Input of one schedule creation. */
export interface ScheduleCreateInput {
  readonly prompt: string
  readonly rule: SchedulerRule
  readonly target: { readonly kind: 'current' | 'job' }
  readonly contextMode: 'fresh' | 'continue'
  readonly createdBy: { readonly kind: 'user' | 'model'; readonly sessionId: SessionId }
}

/** Remote-facing creation input: {@link ScheduleCreateInput} without the
 * server-derived `createdBy` provenance. */
export interface ScheduleCreateRemoteInput {
  readonly prompt: string
  readonly rule: SchedulerRule
  readonly target: { readonly kind: 'current' | 'job' }
  readonly contextMode: 'fresh' | 'continue'
}
