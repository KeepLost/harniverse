/**
 * New-session button skin-seam contract, asserted against the CSS text on
 * disk: the button sits directly on the sidebar column, which owns the surface,
 * so it paints no opaque alias (the elevated button fill is not skinnable): a
 * hairline carries the shape and the hover fill is an alpha token.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Declarations of every rule whose selector list contains the exact selector.
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

const ROOT = '../src/client/SidebarRoot.module.css'

describe('SidebarRoot.module.css new-session button', () => {
  it('is transparent at rest with a hairline border', () => {
    const button = declarations(ROOT, '.newSession')
    expect(button.get('background')).toBe('transparent')
    expect(button.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
  })

  it('fills with an alpha token on hover', () => {
    expect(declarations(ROOT, '.newSession:hover').get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
  })
})
