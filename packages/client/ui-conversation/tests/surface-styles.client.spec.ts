/**
 * Conversation skin-seam contract, asserted against the CSS text on disk: the
 * conversation pane, the composer card, and the context popover read the
 * surface and material tokens (so a skin can make them translucent or glassy)
 * instead of the opaque aliases they default to, and the details occupant
 * leaves its surface to the layout column. The reference chips take their tint
 * from the accent chip token, so they follow a user or skin accent.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Declarations of one exact selector across a stylesheet, later rules winning.
 * @param relative - stylesheet path relative to this spec.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property, whitespace collapsed.
 */
function declarations(relative: string, selector: string): Map<string, string> {
  const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

const ROOT = '../src/client/skeleton/ConversationRoot.module.css'
const DETAILS = '../src/client/skeleton/DetailsPanel.module.css'
const INPUT = '../src/client/skeleton/InputBar.module.css'
const METER = '../src/client/skeleton/ContextMeter.module.css'
const MESSAGE = '../src/client/chat/MessageItem.module.css'

describe('ConversationRoot.module.css pane surface', () => {
  it('fills the column with the pane surface token', () => {
    expect(declarations(ROOT, '.root').get('background')).toBe('var(--dsw-surface-pane)')
  })

  it('fades the composer seat through the pane surface, not the opaque alias', () => {
    const seat = declarations(ROOT, ".root[data-phase='active'] .composerSeat").get('background')
    expect(seat).toContain('var(--dsw-surface-pane) 36px')
    expect(seat).toContain('color-mix(in srgb, var(--dsw-surface-pane) 0%, transparent) 0px')
    expect(seat).not.toContain('--dsw-alias-bg-base')
  })
})

describe('DetailsPanel.module.css surface', () => {
  it('paints no fill of its own: the layout column owns the details surface', () => {
    expect(declarations(DETAILS, '.root').has('background')).toBe(false)
  })
})

describe('InputBar.module.css composer surface', () => {
  it('fills the card with the composer surface token', () => {
    expect(declarations(INPUT, '.card').get('background')).toBe('var(--dsw-surface-composer)')
  })

  it('puts the composer filter on a plate behind the card content, never on the card', () => {
    expect(declarations(INPUT, '.card').has('backdrop-filter')).toBe(false)
    expect(declarations(INPUT, '.card').get('isolation')).toBe('isolate')
    const plate = declarations(INPUT, '.card::before')
    expect(plate.get('content')).toBe("''")
    expect(plate.get('position')).toBe('absolute')
    expect(plate.get('inset')).toBe('0')
    expect(plate.get('z-index')).toBe('-1')
    expect(plate.get('border-radius')).toBe('inherit')
    expect(plate.get('pointer-events')).toBe('none')
    expect(plate.get('backdrop-filter')).toBe('var(--dsw-material-composer-filter)')
  })
})

describe('ContextMeter.module.css popover surface', () => {
  it('fills the panel with the popover surface and filter tokens', () => {
    const panel = declarations(METER, '.panel')
    expect(panel.get('background')).toBe('var(--dsw-surface-popover)')
    expect(panel.get('backdrop-filter')).toBe('var(--dsw-material-popover-filter)')
  })
})

describe('reference chips follow the accent', () => {
  it('tints the composer chip and the transcript chip from the accent chip token, not a blue literal', () => {
    expect(declarations(INPUT, '.chip').get('background')).toBe('var(--dsw-accent-chip)')
    expect(declarations(MESSAGE, '.refChip').get('background')).toBe('var(--dsw-accent-chip)')
  })
})
