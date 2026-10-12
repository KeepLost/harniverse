/**
 * Composer-seat skin-seam contract, asserted against the CSS text on disk: the
 * question and plan-review takeovers occupy the input card's seat, so they read
 * the composer surface and carry the composer glass on a plate behind their
 * content (never on the card, which would make it the containing block of its
 * fixed descendants), and nothing inside them patches the card with an opaque
 * alias.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Fill aliases that paint an opaque block over a translucent surface. */
const OPAQUE_ALIASES = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-specific-input-major',
  '--dsw-specific-menu',
  '--dsw-specific-tip',
]

/**
 * Stylesheet text with comments removed.
 * @param relative - stylesheet path relative to this spec.
 * @returns the declarations-only CSS text.
 */
function sheet(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * Declarations of every rule whose selector list contains the exact selector.
 * @param relative - stylesheet path relative to this spec.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property, whitespace collapsed.
 */
function declarations(relative: string, selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of sheet(relative).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

/**
 * Every `background*` value a stylesheet declares that reads an opaque alias.
 * @param relative - stylesheet path relative to this spec.
 * @returns the offending declaration values.
 */
function opaqueFills(relative: string): string[] {
  const offending: string[] = []
  for (const [, , body = ''] of sheet(relative).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1 || !part.slice(0, colon).trim().startsWith('background')) continue
      const value = part.slice(colon + 1).trim()
      if ([...value.matchAll(/--dsw-[\w-]+/g)].some(([name]) => OPAQUE_ALIASES.includes(name))) offending.push(value)
    }
  }
  return offending
}

/**
 * Assert the composer-seat contract of one card selector.
 * @param relative - stylesheet path relative to this spec.
 * @param selector - the card's exact selector.
 */
function expectComposerSeat(relative: string, selector: string): void {
  const card = declarations(relative, selector)
  expect(card.get('background'), `${selector} background`).toBe('var(--dsw-surface-composer)')
  expect(card.has('backdrop-filter'), `${selector} carries no filter itself`).toBe(false)
  expect(card.get('position'), `${selector} anchors the plate`).toBe('relative')
  expect(card.get('isolation'), `${selector} stacking context`).toBe('isolate')
  const plate = declarations(relative, `${selector}::before`)
  expect(plate.get('content')).toBe("''")
  expect(plate.get('position')).toBe('absolute')
  expect(plate.get('inset')).toBe('0')
  expect(plate.get('z-index')).toBe('-1')
  expect(plate.get('border-radius')).toBe('inherit')
  expect(plate.get('pointer-events')).toBe('none')
  expect(plate.get('backdrop-filter')).toBe('var(--dsw-material-composer-filter)')
}

const QUESTION = '../src/client/QuestionComposer.module.css'
const PLAN = '../src/client/PlanReviewPanel.module.css'

describe('QuestionComposer.module.css composer seat', () => {
  it('reads the composer surface with the glass on a plate behind the card content', () => {
    expectComposerSeat(QUESTION, '.card')
  })

  it('leaves the custom-answer field transparent inside the card, with its hairline border', () => {
    const field = declarations(QUESTION, '.customTextarea')
    expect(field.get('background')).toBe('transparent')
    expect(field.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
  })

  it('tints the number badge with an alpha token', () => {
    expect(declarations(QUESTION, '.number').get('background')).toBe('var(--dsw-alias-interactive-bg-active)')
  })

  it('declares no opaque alias fill anywhere in the sheet', () => {
    expect(opaqueFills(QUESTION)).toEqual([])
  })
})

describe('PlanReviewPanel.module.css composer seat', () => {
  it('reads the composer surface with the glass on a plate behind the card content', () => {
    expectComposerSeat(PLAN, '.card')
  })

  it('declares no opaque alias fill anywhere in the sheet', () => {
    expect(opaqueFills(PLAN)).toEqual([])
  })
})
