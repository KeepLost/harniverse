/**
 * Adaptive content-width stylesheet contract, asserted against the CSS text on
 * disk: ConversationRoot.module.css resolves the shared
 * `--dsh-chat-content-width` axis through a clamp over the live column width
 * (`--dsh-conversation-column-width`, published by the component's ResizeObserver)
 * — a 748px floor keeps today's fixed width on ordinary columns, 64% of wider
 * columns grows the reading measure, and a 920px cap preserves line-length
 * readability — and the user bubble holds the figma 525px cap as a share of
 * that axis (525/748 ≈ 0.702) so it widens with the column instead of
 * clipping at a fixed px.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = '../src/client/skeleton/ConversationRoot.module.css'
const MESSAGE_CSS = '../src/client/chat/MessageItem.module.css'

/** Declarations of every rule whose selector list contains the selector. */
function declarationsOf(relative: string, selector: string): [string, string][] {
  const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: { selectors: string[]; declarations: [string, string][] }[] = []
  for (const [, selectorText = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = body
      .split(';')
      .map(part => part.trim())
      .filter(part => part.includes(':'))
      .map((part): [string, string] => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
      })
    rules.push({ selectors: selectorText.split(',').map(part => part.trim()), declarations })
  }
  return rules
    .filter(rule => rule.selectors.includes(selector))
    .flatMap(rule => rule.declarations)
}

describe('ConversationRoot adaptive content width', () => {
  it('the shared width axis clamps the live column share between the fixed floor and the readability cap', () => {
    expect(declarationsOf(CSS, '.root')).toEqual(expect.arrayContaining([
      ['--dsh-chat-content-width',
        'clamp(748px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px)'],
    ] as [string, string][]))
  })

  it('the user bubble cap rides the width axis as its historical share', () => {
    expect(declarationsOf(MESSAGE_CSS, '.userStack')).toEqual(expect.arrayContaining([
      ['max-width', 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)'],
    ] as [string, string][]))
  })
})
