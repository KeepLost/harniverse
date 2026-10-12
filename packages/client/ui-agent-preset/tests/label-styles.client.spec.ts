/**
 * AgentPresetLabel skin-seam contract, asserted against the CSS text on disk:
 * the session-header chip sits on the conversation column's surface, so its
 * tint is an alpha token rather than an opaque layer alias.
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

const LABEL = '../src/client/AgentPresetLabel.module.css'

describe('AgentPresetLabel.module.css chip', () => {
  it('tints the chip with an alpha token so the column surface shows through', () => {
    expect(declarations(LABEL, '.label').get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
  })
})
