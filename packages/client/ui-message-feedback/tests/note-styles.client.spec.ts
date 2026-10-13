/**
 * Feedback note field skin-seam contract, asserted against the CSS text on
 * disk: the note editor sits under a message on the transcript pane, so the
 * textarea is transparent behind its hairline border rather than an opaque
 * input-surface patch.
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

const ACTIONS = '../src/client/MessageFeedbackActions.module.css'

describe('MessageFeedbackActions.module.css note field', () => {
  it('is transparent with a hairline border', () => {
    const field = declarations(ACTIONS, '.noteInput')
    expect(field.get('background')).toBe('transparent')
    expect(field.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
  })
})
