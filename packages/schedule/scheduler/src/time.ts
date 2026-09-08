/**
 * Pure due-time arithmetic for the at/after/every rule grammar. The anchor of
 * an `every` rule is the first due moment, so recurrence is
 * `anchor + k·interval` for `k ≥ 0`.
 * @module @deepseek-ai/dsh-scheduler/time
 */

import type { SchedulerRule } from './types.ts'

/** Minimum recurrence interval; the official schedule floor. */
export const MIN_EVERY_INTERVAL_MS = 5 * 60_000

/** Maximum accepted prompt length in UTF-16 code units. */
export const MAX_PROMPT_LENGTH = 8_000

/** Maximum accepted one-shot delay in milliseconds (30 days). */
export const MAX_DELAY_MS = 30 * 24 * 60 * 60_000

/**
 * Parse one `at`/`anchor` instant.
 * @param value - RFC 3339 or naive local datetime string.
 * @returns epoch milliseconds, or `undefined` when unparseable.
 */
export function parseInstant(value: string): number | undefined {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Compute the first due moment for one rule.
 * @param rule - validated rule.
 * @param createdAt - record creation epoch ms.
 * @returns the first due epoch ms, or `undefined` for an invalid instant.
 */
export function initialDue(rule: SchedulerRule, createdAt: number): number | undefined {
  switch (rule.kind) {
    case 'after': return createdAt + rule.delayMs
    case 'at': return parseInstant(rule.at)
    case 'every': return parseInstant(rule.anchor)
  }
}

/**
 * Compute the next due moment after one dispatched due slot.
 * @param rule - validated rule.
 * @param lastDue - the due slot that was just dispatched.
 * @returns the next due epoch ms, or `undefined` when the rule is exhausted.
 */
/**
 * Compute the next due moment after one dispatched due slot. Anchors are
 * ISO-normalized by {@link validateRule}, so `Date.parse` is total here; a
 * corrupted anchor surfaces as a non-integer next due at the durable read.
 * @param rule - validated rule.
 * @param lastDue - the due slot that was just dispatched.
 * @returns the next due epoch ms, or `undefined` when the rule is exhausted.
 */
export function subsequentDue(rule: SchedulerRule, lastDue: number): number | undefined {
  if (rule.kind !== 'every') return undefined
  const anchor = Date.parse(rule.anchor)
  const steps = Math.floor((lastDue - anchor) / rule.intervalMs) + 1
  return anchor + steps * rule.intervalMs
}

/**
 * Advance one overdue `every` due slot to its latest missed boundary, the
 * skip-to-latest missed policy; one-shot rules keep their slot.
 * @param rule - validated rule.
 * @param due - the due slot selected for dispatch.
 * @param now - current epoch ms.
 * @returns the effective due slot to record for this dispatch.
 */
export function latestMissedDue(rule: SchedulerRule, due: number, now: number): number {
  if (rule.kind !== 'every') return due
  const anchor = Date.parse(rule.anchor)
  const skipped = Math.floor((now - anchor) / rule.intervalMs)
  const latest = anchor + skipped * rule.intervalMs
  return latest > due ? latest : due
}

/** Structured rejection of one rule candidate. */
export class ScheduleRuleError extends Error {
  override readonly name = 'ScheduleRuleError'

}

/**
 * Validate one raw rule candidate and normalize it.
 * @param candidate - unvalidated rule.
 * @param createdAt - record creation epoch ms; the anchor for anchored recurrences.
 * @returns the validated rule and its first due moment.
 * @throws {@link ScheduleRuleError} with a stable reason for invalid input.
 */
export function validateRule(
  candidate: SchedulerRule,
  createdAt: number,
): { rule: SchedulerRule; due: number } {
  switch (candidate.kind) {
    case 'after':
      if (!Number.isSafeInteger(candidate.delayMs) || candidate.delayMs <= 0 || candidate.delayMs > MAX_DELAY_MS) {
        throw new ScheduleRuleError('delay must be a positive duration of at most 30 days')
      }
      return { rule: candidate, due: createdAt + candidate.delayMs }
    case 'at': {
      const due = parseInstant(candidate.at)
      if (due === undefined) throw new ScheduleRuleError('run_at must be a parseable datetime')
      return { rule: { kind: 'at', at: new Date(due).toISOString() }, due }
    }
    case 'every': {
      if (!Number.isSafeInteger(candidate.intervalMs)
        || candidate.intervalMs < MIN_EVERY_INTERVAL_MS
        || candidate.intervalMs > MAX_DELAY_MS) {
        throw new ScheduleRuleError('every_minutes must be an interval of at least 5 minutes and at most 30 days')
      }
      const anchor = parseInstant(candidate.anchor)
      if (anchor === undefined) throw new ScheduleRuleError('anchor must be a parseable datetime')
      return { rule: { kind: 'every', intervalMs: candidate.intervalMs, anchor: new Date(anchor).toISOString() }, due: anchor }
    }
  }
}
