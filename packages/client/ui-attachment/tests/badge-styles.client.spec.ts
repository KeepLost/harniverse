/**
 * File badge skin-seam contract, asserted against the CSS text on disk: the
 * receipt badges sit beside a user message on the transcript pane, so they
 * tint with the same alpha token as the composer chip above them instead of an
 * opaque layer alias. The rail's scroll arrows float over the chips they hide
 * and keep their opaque fill.
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

const BADGES = '../src/FileChips.module.css'
const RAIL = '../src/AttachmentRail.module.css'

describe('FileChips.module.css badges', () => {
  it('tints the badge with the chip alpha token', () => {
    expect(declarations(BADGES, '.badge').get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(declarations(BADGES, '.chip').get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
  })
})

describe('AttachmentRail.module.css arrows', () => {
  it('keeps the opaque composer fill because the arrow covers the chips scrolling under it', () => {
    expect(declarations(RAIL, '.arrow').get('background')).toBe('var(--dsw-specific-input-major)')
  })
})
