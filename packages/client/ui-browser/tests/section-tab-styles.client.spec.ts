/**
 * BrowserSectionTab narrow-width contract, asserted against the CSS text on disk: below the
 * workbench's 380px container width the tab drops its label to the glyph, as
 * the shipped section tabs do. The workbench's container is named, but CSS
 * Modules hash container names per module, so the query here is anonymous and
 * matches the tab's nearest ancestor container (the workbench root).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/BrowserSectionTab.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Declarations of every rule in a stylesheet fragment whose selector list contains the exact selector.
 * @param text - comment-free stylesheet text.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property, whitespace collapsed.
 */
function declarationsIn(text: string, selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

describe('BrowserSectionTab.module.css narrow workbench', () => {
  it('queries the nearest container anonymously because CSS Modules hash container names per module', () => {
    expect(css).toMatch(/@container\s*\(max-width:\s*380px\)\s*\{/)
    expect(css).not.toMatch(/@container\s+[\w-]+\s*\(/)
  })

  it('drops the label to the glyph and tightens the padding inside the query', () => {
    const narrow = css.slice(css.indexOf('@container'))
    expect(declarationsIn(narrow, '.tab > span').get('display')).toBe('none')
    expect(declarationsIn(narrow, '.tab').get('padding')).toBe('0 8px')
  })

  it('keeps the full padding and a visible label outside the query', () => {
    const base = css.slice(0, css.indexOf('@container'))
    expect(declarationsIn(base, '.tab').get('padding')).toBe('0 10px')
    expect(declarationsIn(base, '.tab > span').has('display')).toBe(false)
  })
})
