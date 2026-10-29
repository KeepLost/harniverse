// @vitest-environment jsdom
/** Blockquote presentation with the marker stripped and inner text literal. */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotedUserText } from '../src/client/QuotedUserText.tsx'
import { createQuoteRule } from '../src/client/quote-rule.ts'

afterEach(() => {
  cleanup()
})

function quote(raw: string, data?: unknown): HTMLElement {
  return render(
    <QuotedUserText raw={raw} interactive data={data} />,
  ).container.querySelector('[data-quote]') as HTMLElement
}

describe('QuotedUserText', () => {
  it('draws one excerpt as a block quote with one marker level stripped', () => {
    const element = quote('> first\n> line', { text: 'first\nline' })
    expect(element.tagName).toBe('BLOCKQUOTE')
    expect(element.textContent).toBe('first\nline')
    expect(element.textContent).not.toContain('>')
  })

  it('draws deeper markers and inner markdown literally, without re-interpretation', () => {
    const element = quote('> > nested\n> **bold** `code`', { text: '> nested\n**bold** `code`' })
    expect(element.textContent).toBe('> nested\n**bold** `code`')
    expect(element.querySelector('strong,em,code,h1')).toBeNull()
  })

  it('falls back to decoding the raw characters when the seam carries no prepared text', () => {
    const element = quote('> first\r\n  > > nested\n>third')
    expect(element.textContent).toBe('first\n> nested\nthird')
  })

  it('renders through the rule Render component over the seam props', () => {
    const rule = createQuoteRule()
    const raw = '> quoted reply'
    const match = rule.nextMatch(`x\n${raw}\ny`, 0)
    expect(match).toBeDefined()
    const element = render(
      <rule.Render raw={raw} interactive data={match?.data} />,
    ).container.querySelector('[data-quote]') as HTMLElement
    expect(element.textContent).toBe('quoted reply')
  })
})
