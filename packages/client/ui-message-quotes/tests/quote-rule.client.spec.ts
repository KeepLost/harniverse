/** The `quote` sent-user-text rule: recognition, payloads, and forward queries. */

import { describe, expect, it } from 'vitest'
import { createQuoteRule } from '../src/client/quote-rule.ts'

describe('the quote rule', () => {
  it('carries the rule identity and a render component', () => {
    const rule = createQuoteRule()
    expect(rule.id).toBe('quote')
    expect(rule.Render).toBeTypeOf('function')
  })

  it('answers advancing nextMatch queries with the recognized spans', () => {
    const text = 'before\n\n> first\n> line\n\n> second\n\nafter'
    const rule = createQuoteRule()
    const seen: string[] = []
    let from = 0
    while (from <= text.length) {
      const match = rule.nextMatch(text, from)
      if (match === undefined) break
      seen.push(text.slice(match.start, match.end))
      from = Math.max(match.end, match.start + 1)
    }
    expect(seen).toEqual(['> first\n> line', '> second'])
  })

  it('carries the decoded excerpt on the match data for the renderer', () => {
    const rule = createQuoteRule()
    const match = rule.nextMatch('x\n> first\n  > > nested\n>third', 0)
    expect(match).toBeDefined()
    expect(match?.data).toEqual({ text: 'first\n> nested\nthird' })
  })

  it('resumes from a cursor inside an earlier span at the next span', () => {
    const rule = createQuoteRule()
    const text = '> one\n\ntext\n> two'
    const first = rule.nextMatch(text, 0)
    expect(first).toBeDefined()
    expect(rule.nextMatch(text, first!.end)?.start).toBe(text.indexOf('> two'))
  })

  it('finds no match in text without a nonblank explicit quote span', () => {
    const rule = createQuoteRule()
    expect(rule.nextMatch('a > b\n    > code\n> \n>', 0)).toBeUndefined()
    expect(rule.nextMatch('', 0)).toBeUndefined()
  })

  it('memoizes one text, so repeated queries reuse the same scan', () => {
    const rule = createQuoteRule()
    const text = '> a\n\n> b'
    const first = rule.nextMatch(text, 0)
    expect(rule.nextMatch(text, first!.end)?.start).toBe(text.indexOf('> b'))
    // The same text again hits the memo rather than re-scanning.
    expect(rule.nextMatch(text, 0)).toEqual(first)
  })
})
