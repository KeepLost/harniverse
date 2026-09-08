import { describe, expect, it } from 'vitest'
import {
  MAX_DELAY_MS,
  MIN_EVERY_INTERVAL_MS,
  ScheduleRuleError,
  initialDue,
  latestMissedDue,
  parseInstant,
  subsequentDue,
  validateRule,
} from '@deepseek-ai/dsh-scheduler/src/time.ts'
import type { SchedulerRule } from '@deepseek-ai/dsh-scheduler/src/types.ts'

const CREATED = 1_700_000_000_000

describe('parseInstant', () => {
  it('parses RFC 3339 instants and rejects garbage', () => {
    expect(parseInstant('2026-09-09T01:02:03.000Z')).toBe(Date.parse('2026-09-09T01:02:03.000Z'))
    expect(parseInstant('not a date')).toBeUndefined()
  })
})

describe('validateRule', () => {
  it('accepts a bounded one-shot delay', () => {
    const { rule, due } = validateRule({ kind: 'after', delayMs: 60_000 }, CREATED)
    expect(rule).toEqual({ kind: 'after', delayMs: 60_000 })
    expect(due).toBe(CREATED + 60_000)
  })

  it('rejects non-positive, fractional, and oversized delays', () => {
    expect(() => validateRule({ kind: 'after', delayMs: 0 }, CREATED)).toThrow(ScheduleRuleError)
    expect(() => validateRule({ kind: 'after', delayMs: -1 }, CREATED)).toThrow(ScheduleRuleError)
    expect(() => validateRule({ kind: 'after', delayMs: 1.5 }, CREATED)).toThrow(ScheduleRuleError)
    expect(() => validateRule({ kind: 'after', delayMs: MAX_DELAY_MS + 1 }, CREATED)).toThrow(ScheduleRuleError)
  })

  it('normalizes a parseable at instant and rejects unparseable ones', () => {
    const { rule, due } = validateRule({ kind: 'at', at: '2026-09-09T01:02:03Z' }, CREATED)
    expect(rule).toEqual({ kind: 'at', at: '2026-09-09T01:02:03.000Z' })
    expect(due).toBe(Date.parse('2026-09-09T01:02:03Z'))
    expect(() => validateRule({ kind: 'at', at: 'later' }, CREATED)).toThrow(ScheduleRuleError)
  })

  it('enforces the recurrence floor and cap', () => {
    const anchor = new Date(CREATED).toISOString()
    const { rule, due } = validateRule(
      { kind: 'every', intervalMs: MIN_EVERY_INTERVAL_MS, anchor },
      CREATED,
    )
    expect(rule).toEqual({ kind: 'every', intervalMs: MIN_EVERY_INTERVAL_MS, anchor })
    expect(due).toBe(CREATED)
    expect(() => validateRule({ kind: 'every', intervalMs: MIN_EVERY_INTERVAL_MS - 1, anchor }, CREATED))
      .toThrow(ScheduleRuleError)
    expect(() => validateRule({ kind: 'every', intervalMs: MAX_DELAY_MS + 1, anchor }, CREATED))
      .toThrow(ScheduleRuleError)
    expect(() => validateRule({ kind: 'every', intervalMs: MIN_EVERY_INTERVAL_MS, anchor: 'soon' }, CREATED))
      .toThrow(ScheduleRuleError)
  })
})

describe('due progression', () => {
  const anchor = new Date(CREATED).toISOString()
  const every: SchedulerRule = { kind: 'every', intervalMs: 300_000, anchor }

  it('computes the first due from the anchor', () => {
    expect(initialDue(every, CREATED + 50)).toBe(CREATED)
    expect(initialDue({ kind: 'at', at: anchor }, CREATED)).toBe(CREATED)
    expect(initialDue({ kind: 'after', delayMs: 1_000 }, CREATED)).toBe(CREATED + 1_000)
  })

  it('walks anchored recurrence slots', () => {
    expect(subsequentDue(every, CREATED)).toBe(CREATED + 300_000)
    expect(subsequentDue(every, CREATED + 300_000)).toBe(CREATED + 600_000)
    expect(subsequentDue({ kind: 'after', delayMs: 1 }, CREATED)).toBeUndefined()
    expect(subsequentDue({ kind: 'at', at: anchor }, CREATED)).toBeUndefined()
  })

  it('skips an overdue recurrence to its latest missed slot', () => {
    const now = CREATED + 950_000
    expect(latestMissedDue(every, CREATED, now)).toBe(CREATED + 900_000)
    expect(latestMissedDue(every, CREATED + 900_000, now)).toBe(CREATED + 900_000)
    expect(latestMissedDue({ kind: 'after', delayMs: 1 }, CREATED, now)).toBe(CREATED)
  })
})
