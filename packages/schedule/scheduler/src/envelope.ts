/**
 * Model-facing delivery envelope for scheduled prompts.
 *
 * The delivered message is the one place schedule facts reach the model:
 * content needs the schedule's own prompt plus the delivery's progress
 * (rule, planned and actual moments, next run), so an agent — including one
 * whose earlier turns were compacted away or whose surface was reset for a
 * fresh-context run — can still reason about its cadence. Structured
 * progress also rides the message source for UI provenance without parsing
 * the model-facing text.
 *
 * @module @deepseek-ai/dsh-scheduler
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ScheduleRecord, SchedulerRule } from './types.ts'

/** One-line rule summary for the envelope. */
function describeRule(rule: SchedulerRule): string {
  switch (rule.kind) {
    case 'after':
      return `once, ${String(rule.delayMs)}ms after creation`
    case 'at':
      return `once, at ${rule.at}`
    case 'every':
      return `every ${String(rule.intervalMs)}ms from ${rule.anchor}`
  }
}

/**
 * Build one scheduled delivery message: a bounded progress envelope around
 * the verbatim schedule prompt.
 * @param record - the schedule being delivered (prompt at its current revision).
 * @param due - the due moment this delivery serves.
 * @param firedAt - the moment the scheduler dispatched this delivery.
 * @param nextDue - the record's next due moment after this one, when recurring.
 * @returns the plugin-sourced user message carrying envelope and prompt.
 */
export function scheduledDeliveryMessage(
  record: ScheduleRecord,
  due: number,
  firedAt: number,
  nextDue: number | undefined,
): UserMessage {
  const progress = nextDue === undefined
    ? 'no further runs are scheduled'
    : `the next run is due ${new Date(nextDue).toISOString()}`
  const text = [
    `Scheduled task ${record.id} fired (rule: ${describeRule(record.rule)}).`,
    `Planned for ${new Date(due).toISOString()}; fired at ${new Date(firedAt).toISOString()}; ${progress}.`,
    'Use schedule_list to review or schedule_delete to cancel.',
    '',
    record.prompt,
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'schedule',
      scheduleId: record.id,
      rule: record.rule,
      dueAt: due,
      firedAt,
      ...nextDue === undefined ? {} : { nextDue },
    },
  })
}
