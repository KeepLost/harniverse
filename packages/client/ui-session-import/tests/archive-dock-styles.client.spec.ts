/**
 * ArchiveDock skin-seam contract, asserted against the CSS text on disk: the
 * archive notice is a card of the composer stack, so it reads the composer
 * surface and carries the composer glass on a plate behind its content (never
 * on the dock, which would make it the containing block of its fixed
 * descendants).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

const DOCK = '../src/client/ArchiveDock.module.css'

describe('ArchiveDock.module.css composer stack card', () => {
  it('reads the composer surface with the glass on a plate behind the dock content', () => {
    expectComposerSeat(DOCK, '.dock')
  })

  it('keeps its hairline border above the plate', () => {
    expect(declarations(DOCK, '.dock').get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
  })
})
