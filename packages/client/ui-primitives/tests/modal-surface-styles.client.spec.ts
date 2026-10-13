/**
 * Modal skin-seam contract, asserted against the CSS text on disk: the dialog
 * card reads the dialog surface token (so a skin can make dialogs translucent
 * and an opacity of 100% stays opaque), carries the dialog material on a
 * `::before` plate instead of on the card (a filter on the card would make it
 * the containing block of its fixed-position descendants), and leaves the mask
 * scrim alone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Modal.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

/** One rule: its selector list and declarations, whitespace collapsed. */
interface Rule { selectors: string[]; declarations: Map<string, string> }

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList = '', body = '']) => ({
  selectors: selectorList.split(',').map(value => value.trim()),
  declarations: new Map(body.split(';').flatMap((part): [string, string][] => {
    const colon = part.indexOf(':')
    return colon === -1 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')]]
  })),
}))

/**
 * Value of a property across the rules whose selector list contains the selector.
 * @param selector - exact selector text.
 * @param property - declaration name.
 * @returns the value of the last matching declaration, or undefined when none declares it.
 */
function valueOf(selector: string, property: string): string | undefined {
  const values = rules.filter(rule => rule.selectors.includes(selector)).flatMap(rule => rule.declarations.get(property) ?? [])
  return values.at(-1)
}

describe('Modal.module.css dialog surface', () => {
  it('fills the dialog card with the dialog surface token, not the raw layer-2 alias', () => {
    expect(valueOf('.dialog', 'background')).toBe('var(--dsw-surface-dialog)')
    expect(css).not.toContain('--dsw-alias-bg-layer-2')
  })

  it('keeps the card a stacking context that clips to its radius, so the glass plate stays inside it', () => {
    expect(valueOf('.dialog', 'position')).toBe('relative')
    expect(valueOf('.dialog', 'z-index')).toBe('1')
    expect(valueOf('.dialog', 'overflow')).toBe('hidden')
  })

  it('paints the dialog material on a ::before plate behind the content, never on the card', () => {
    expect(valueOf('.dialog', 'backdrop-filter')).toBeUndefined()
    expect(valueOf('.dialog', 'filter')).toBeUndefined()
    expect(Object.fromEntries(rules.find(rule => rule.selectors.includes('.dialog::before'))!.declarations)).toEqual({
      content: "''",
      position: 'absolute',
      inset: '0',
      'z-index': '-1',
      'border-radius': 'inherit',
      'pointer-events': 'none',
      'backdrop-filter': 'var(--dsw-material-dialog-filter)',
    })
  })

  it('leaves the mask scrim on its own tokens', () => {
    expect(valueOf('.mask', 'background')).toBe('var(--dsw-alias-bg-mask-1)')
    expect(valueOf('.mask', 'backdrop-filter')).toBe('var(--dsw-mask-blur)')
  })
})
