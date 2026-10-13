/**
 * Skill row inspect pill skin-seam contract, asserted against the CSS text on
 * disk: the pill sits in flow under the expanded instructions card on the
 * transcript pane, so it paints no opaque alias over a translucent pane; the
 * hairline carries its shape and the hover fill is an alpha token.
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

const ROW = '../src/client/SkillRow.module.css'

describe('SkillRow.module.css inspect pill', () => {
  it('is transparent at rest with a hairline border', () => {
    const pill = declarations(ROW, '.inspectButton')
    expect(pill.get('background')).toBe('transparent')
    expect(pill.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
  })

  it('fills with an alpha token on hover', () => {
    expect(declarations(ROW, '.inspectButton:hover').get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
  })
})
