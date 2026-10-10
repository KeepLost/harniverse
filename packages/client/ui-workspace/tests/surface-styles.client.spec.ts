/**
 * Workspace skin-seam contract, asserted against the CSS text on disk: the
 * workbench leaves its surface to the layout's details column, the sidebar
 * list fades its rows out rather than painting a fill over them, and the preview sheet that
 * slides over the conversation keeps its opaque fill.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Declarations of one exact selector across a stylesheet, whitespace collapsed.
 * @param relative - stylesheet path relative to this spec.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property.
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

const WORKBENCH = '../src/client/WorkspaceWorkbench.module.css'
const BROWSER = '../src/client/WorkspaceBrowser.module.css'
const PREVIEW = '../src/client/WorkbenchPreview.module.css'

describe('WorkspaceWorkbench.module.css surface', () => {
  it('paints no fill on the root or the navigator: the details column owns the surface', () => {
    expect(declarations(WORKBENCH, '.root').has('background')).toBe(false)
    expect(declarations(WORKBENCH, '.navigator').has('background')).toBe(false)
  })
})

describe('WorkspaceBrowser.module.css list fade', () => {
  it('dissolves the rows into the sidebar instead of painting a fill over them', () => {
    const list = declarations(BROWSER, '.list')
    // A fill over the rows would stack on a translucent sidebar's own fill and darken the column foot.
    expect(list.get('mask-image')).toBe('linear-gradient(to bottom, #000 calc(100% - 24px), transparent), linear-gradient(#000, #000)')
    expect(list.get('mask-position')).toBe('0 0, 100% 0')
    expect(list.get('mask-repeat')).toBe('no-repeat')
    expect(readFileSync(fileURLToPath(new URL(BROWSER, import.meta.url)), 'utf8')).not.toContain('.fade')
  })
})

describe('WorkbenchPreview.module.css sheet', () => {
  it('keeps the opaque pane alias because the sheet covers the conversation', () => {
    expect(declarations(PREVIEW, '.host').get('background')).toBe('var(--dsw-alias-bg-base)')
  })
})
