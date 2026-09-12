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
const INPUT_CSS = '../src/client/skeleton/InputBar.module.css'
const STATS_CSS = '../src/client/chat/StatsLine.module.css'
const ICON_CSS = '../src/client/chat/MessageIconActions.module.css'

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

  it('a phone frame drops the desktop floor so the axis follows the column', () => {
    expect(declarationsOf(CSS, ":global([data-viewport='phone']) .root")).toEqual(expect.arrayContaining([
      ['--dsh-chat-content-width', 'min(748px, 100%)'],
      ['--dsh-composer-side-clearance', '8px'],
    ] as [string, string][]))
  })
})

describe('composer row concession', () => {
  it('the right group concedes width instead of pushing the deficit onto the mode chips', () => {
    // `flex: none` here overlapped the supervision label with the model name:
    // the whole row deficit landed on .tools, which bottomed out at
    // min-content and overflowed the card.
    expect(declarationsOf(INPUT_CSS, '.trailing')).toEqual(expect.arrayContaining([
      ['flex', '0 1 auto'],
      ['min-width', '0'],
    ] as [string, string][]))
  })

  it('the wide card keeps the send pair as the rightmost flex item of the row', () => {
    expect(declarationsOf(INPUT_CSS, '.trailing')).toEqual(expect.arrayContaining([
      ['margin-left', 'auto'],
    ] as [string, string][]))
    expect(declarationsOf(INPUT_CSS, '.sendSeat')).toEqual(expect.arrayContaining([
      ['flex', 'none'],
    ] as [string, string][]))
  })

  it('the narrow card becomes a two-line grid with the send seat spanning both lines', () => {
    // Phone portrait: one squeezed line cannot hold the button group AND a
    // model name. Tools take the first line, model + context meter the second,
    // and the send seat spans both at the right edge.
    expect(declarationsOf(INPUT_CSS, '.row')).toEqual(expect.arrayContaining([
      ['display', 'grid'],
      ['grid-template-columns', 'minmax(0, 1fr) auto'],
    ] as [string, string][]))
    expect(declarationsOf(INPUT_CSS, '.tools')).toEqual(expect.arrayContaining([['grid-area', 'tools']] as [string, string][]))
    expect(declarationsOf(INPUT_CSS, '.trailing')).toEqual(expect.arrayContaining([['grid-area', 'trail']] as [string, string][]))
    expect(declarationsOf(INPUT_CSS, '.sendSeat')).toEqual(expect.arrayContaining([['grid-area', 'seat']] as [string, string][]))
  })
})

describe('session stats row', () => {
  it('wraps on a phone frame instead of eliding into a touch-unreachable tooltip', () => {
    const phone = Object.fromEntries(declarationsOf(STATS_CSS, ":global([data-viewport='phone']) .root"))
    expect(phone['white-space']).toBe('normal')
    expect(phone.overflow).toBe('visible')
    expect(phone['padding-inline']).toBe('var(--dsh-composer-side-clearance)')
  })
})

describe('turn meta line', () => {
  it('wraps on a phone frame instead of overflowing past the icon actions', () => {
    // The clock · duration · TTFT · throughput line is nowrap on wide frames;
    // a 390px column cannot hold it beside the icons, so the row wraps and
    // grows past the single-line height only when a second line is needed.
    const phone = Object.fromEntries(declarationsOf(ICON_CSS, ":global([data-viewport='phone']) .actions"))
    expect(phone['flex-wrap']).toBe('wrap')
    expect(phone.height).toBe('auto')
    expect(phone['min-height']).toBe('calc(28px + var(--dsw-content-font-delta, 0px))')
    const time = Object.fromEntries(declarationsOf(ICON_CSS, ":global([data-viewport='phone']) .timeEnd"))
    expect(time['white-space']).toBe('normal')
  })
})
