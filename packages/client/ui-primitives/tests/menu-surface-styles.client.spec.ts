/**
 * Menu skin-seam contract, asserted against the CSS text on disk: the primary
 * card and the submenu card read the popover surface token (so a skin can make
 * menus translucent), only the primary card carries the popover material, and
 * neither reads the opaque `--dsw-specific-menu` alias.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Menu.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

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

describe('Menu.module.css popover surface', () => {
  it('fills both cards with the popover surface token', () => {
    expect(valueOf('.list', 'background')).toBe('var(--dsw-surface-popover)')
    expect(valueOf('.submenu', 'background')).toBe('var(--dsw-surface-popover)')
  })

  it('carries the popover material on the primary card only', () => {
    expect(valueOf('.list', 'backdrop-filter')).toBe('var(--dsw-material-popover-filter)')
    expect(valueOf('.submenu', 'backdrop-filter')).toBeUndefined()
  })

  it('no longer reads the opaque menu alias', () => {
    expect(css).not.toContain('--dsw-specific-menu')
  })
})
