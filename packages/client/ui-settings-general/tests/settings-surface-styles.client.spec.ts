/**
 * Settings dialog skin-seam contract, asserted against the CSS text on disk:
 * the panel reads the dialog surface token (so a skin can make it translucent
 * and an opacity of 100% stays opaque), carries the dialog material on a
 * `::before` plate instead of on the panel (the panel clips overflow, and a
 * filter on it would make it the containing block of fixed-position tooltips
 * and menus), keeps the phone sheet on the same fill, and leaves the mask scrim
 * alone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

/** One rule: its selector list and declarations, whitespace collapsed. */
interface Rule { selectors: string[]; declarations: Map<string, string> }

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList = '', body = '']) => ({
  selectors: selectorList.split(',').map(value => value.trim()),
  declarations: new Map(body.split(';').flatMap((part): [string, string][] => {
    const colon = part.indexOf(':')
    return colon === -1 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')]]
  })),
}))

const PHONE_PANEL = ":global([data-viewport='phone']) .panel"

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

describe('SettingsRoot.module.css panel surface', () => {
  it('fills the panel with the dialog surface token, not the raw layer-2 alias', () => {
    expect(valueOf('.panel', 'background')).toBe('var(--dsw-surface-dialog)')
    expect(css).not.toContain('--dsw-alias-bg-layer-2')
  })

  it('keeps the panel a stacking context that clips to its radius, so the glass plate stays inside it', () => {
    expect(valueOf('.panel', 'position')).toBe('relative')
    expect(valueOf('.panel', 'z-index')).toBe('1')
    expect(valueOf('.panel', 'overflow')).toBe('hidden')
  })

  it('paints the dialog material on a ::before plate behind the content, never on the panel', () => {
    expect(valueOf('.panel', 'backdrop-filter')).toBeUndefined()
    expect(valueOf('.panel', 'filter')).toBeUndefined()
    expect(Object.fromEntries(rules.find(rule => rule.selectors.includes('.panel::before'))!.declarations)).toEqual({
      content: "''",
      position: 'absolute',
      inset: '0',
      'z-index': '-1',
      'border-radius': 'inherit',
      'pointer-events': 'none',
      'backdrop-filter': 'var(--dsw-material-dialog-filter)',
    })
  })

  it('lets the phone sheet keep the same fill and square its plate through the inherited radius', () => {
    expect(valueOf(PHONE_PANEL, 'background')).toBeUndefined()
    expect(valueOf(PHONE_PANEL, 'border-radius')).toBe('0')
    expect(valueOf(PHONE_PANEL, 'width')).toBe('100%')
    expect(valueOf(PHONE_PANEL, 'height')).toBe('100%')
  })

  it('leaves the mask scrim on its own tokens', () => {
    expect(valueOf('.mask', 'background')).toBe('var(--dsw-alias-bg-mask-1)')
    expect(valueOf('.mask', 'backdrop-filter')).toBe('var(--dsw-mask-blur)')
  })
})
