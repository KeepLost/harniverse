/**
 * SubagentCatalogAction skin-seam contract, asserted against the CSS text on disk: the card
 * reads the popover surface and material tokens (so a skin can make menus
 * translucent or glassy) instead of the opaque `--dsw-specific-menu` alias.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SubagentCatalogAction.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Declarations of every rule whose selector list contains the exact selector.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property, whitespace collapsed.
 */
function declarations(selector: string): Map<string, string> {
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

describe('SubagentCatalogAction.module.css popover surface', () => {
  it('fills the card with the popover surface token and carries the popover material', () => {
    const card = declarations('.menu')
    expect(card.get('background')).toBe('var(--dsw-surface-popover)')
    expect(card.get('backdrop-filter')).toBe('var(--dsw-material-popover-filter)')
  })

  it('no longer reads the opaque menu alias', () => {
    expect(css).not.toContain('--dsw-specific-menu')
  })
})
