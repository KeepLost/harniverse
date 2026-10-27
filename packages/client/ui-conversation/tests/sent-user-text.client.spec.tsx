// @vitest-environment jsdom
/** The sent-user-text decoration seam: registry reactivity and user-bubble rendering. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { sentUserTextRules } from '../src/client/sent-user-text.ts'
import type { SentUserTextRule } from '../src/client/sent-user-text.ts'

afterEach(() => {
  cleanup()
})

/** A rule stub marking one fixed range. */
function markRule(id: string, start: number, end: number, mark: string): SentUserTextRule {
  return {
    id,
    nextMatch: (text, from) => (from <= start && start < text.length
      ? { start, end, data: { mark } }
      : undefined),
    Render: ({ raw, data }) => <em data-testid={mark}>{raw}|{String((data as { mark?: string } | undefined)?.mark)}</em>,
  }
}

/** Render one user message bubble with the seam live. */
function bubble(text: string): void {
  render(<UserMessageNodeView {...({
    node: { kind: 'user', data: { content: [{ type: 'text', text }], time: 1_000 } },
    loadImage: { load: () => Promise.resolve(undefined) },
    t: (key: string) => key,
  } as unknown as ChatNodeViewProps<'user' | 'steering'>)} />)
}

describe('sentUserTextRules registry', () => {
  it('registers, lists, and disposes exactly its own rule', () => {
    const before = sentUserTextRules.list().length
    const rule = markRule('a', 0, 1, 'a')
    const dispose = sentUserTextRules.register(rule)

    expect(sentUserTextRules.list()).toHaveLength(before + 1)
    expect(sentUserTextRules.list().at(-1)?.id).toBe('a')

    dispose()
    expect(sentUserTextRules.list()).toHaveLength(before)
    // A second dispose is inert.
    dispose()
    expect(sentUserTextRules.list()).toHaveLength(before)
  })

  it('notifies subscribers on registration changes', () => {
    const events: number[] = []
    const unsubscribe = sentUserTextRules.subscribe(() => { events.push(sentUserTextRules.list().length) })
    const dispose = sentUserTextRules.register(markRule('b', 0, 1, 'b'))
    dispose()
    unsubscribe()

    expect(events).toEqual([sentUserTextRules.list().length + 1, sentUserTextRules.list().length])
  })
})

describe('user bubble sent-text decoration', () => {
  it('renders plain text and reference chips unchanged without rules', () => {
    bubble('run /deploy then wait')
    expect(screen.getByText('run')).toBeTruthy()
    expect(screen.getByText('/deploy')).toBeTruthy()
  })

  it('renders matched ranges through the rule and keeps plain segments decorated', () => {
    const dispose = sentUserTextRules.register(markRule('secret', 4, 14, 'masked'))
    try {
      bubble('run sk-test123 then wait')
      expect(screen.getByTestId('masked').textContent).toBe('sk-test123|masked')
      expect(screen.getByText('run')).toBeTruthy()
      expect(screen.getByText('then wait')).toBeTruthy()
    } finally {
      dispose()
    }
  })
})
