/**
 * Workspace skin-seam contract, asserted against the CSS text on disk: the
 * workbench leaves its surface to the layout's details column (its tab band,
 * segmented control, and fields paint no opaque alias over it), the sidebar
 * list fades its rows out rather than painting a fill over them, and the
 * preview sheet that slides over the conversation keeps its opaque fill.
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

/**
 * Whether a fill lets the column behind it show through: no fill, `transparent`,
 * or an alpha interactive token. Every layer, button, and input alias is opaque.
 * @param value - the declared `background`, if any.
 * @returns true when the fill cannot patch a translucent column.
 */
function isTranslucentFill(value: string | undefined): boolean {
  return value === undefined || value === 'transparent' || /^var\(--dsw-alias-interactive-bg-(hover|active)\)$/.test(value)
}

const WORKBENCH = '../src/client/WorkspaceWorkbench.module.css'
const BROWSER = '../src/client/WorkspaceBrowser.module.css'
const PREVIEW = '../src/client/WorkbenchPreview.module.css'
const ROWS = '../src/client/rows/Rows.module.css'

describe('WorkspaceWorkbench.module.css surface', () => {
  it('paints no fill on the root or the navigator: the details column owns the surface', () => {
    expect(declarations(WORKBENCH, '.root').has('background')).toBe(false)
    expect(declarations(WORKBENCH, '.navigator').has('background')).toBe(false)
  })

  it('paints no fill on the section tab band and keeps its bottom rule', () => {
    const band = declarations(WORKBENCH, '.sectionTabs')
    expect(band.has('background')).toBe(false)
    expect(band.get('border-bottom')).toBe('1px solid var(--dsw-alias-border-l1)')
  })

  it('pins the section headers by structure, not by an opaque band', () => {
    for (const selector of ['.filesToolbar', '.searchHeader', '.changesHeader']) {
      const header = declarations(WORKBENCH, selector)
      expect(header.has('background'), selector).toBe(false)
      expect(header.has('position'), selector).toBe(false)
      // Each header feeds a sibling scroll region that fades its rows instead of painting under them.
      expect(declarations(WORKBENCH, '.navigatorScroll').get('mask-image'))
        .toBe('linear-gradient(to bottom, transparent 0, #000 8px)')
    }
    expect(declarations(WORKBENCH, '.searchResults').get('mask-image'))
      .toBe('linear-gradient(to bottom, transparent 0, #000 8px)')
  })

  it('draws the segmented control as a hairline track with the selection on an alpha fill', () => {
    const track = declarations(WORKBENCH, '.segmented')
    expect(track.has('background')).toBe(false)
    expect(track.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(declarations(WORKBENCH, '.segmented button').get('background')).toBe('transparent')
    // The selected fill must be an alpha token so it reads in both palettes: the opaque button fill is white in light.
    expect(declarations(WORKBENCH, '.segmented button[data-active]').get('background')).toBe('var(--dsw-alias-interactive-bg-active)')
  })

  it('leaves the search box and the filter field transparent, with a hairline and an accent focus border', () => {
    expect(declarations(WORKBENCH, '.searchBox').get('background')).toBe('transparent')
    expect(declarations(WORKBENCH, '.searchBox').get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(declarations(WORKBENCH, '.searchBox:focus-within').get('border-color')).toBe('var(--dsw-alias-state-business-primary)')
    expect(declarations(WORKBENCH, '.filterField input').get('background')).toBe('transparent')
    expect(declarations(WORKBENCH, '.filterField input').get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(declarations(WORKBENCH, '.filterField input:focus').get('border-color')).toBe('var(--dsw-alias-state-business-primary)')
  })

  it('declares no opaque alias fill on any control it seats on the translucent column', () => {
    for (const selector of ['.sectionTabs', '.sectionTab', '.segmented', '.segmented button', '.segmented button[data-active]', '.searchBox', '.filterField input', '.treeCreateInput']) {
      expect(isTranslucentFill(declarations(WORKBENCH, selector).get('background')), selector).toBe(true)
    }
  })
})

describe('rows/Rows.module.css rename field', () => {
  it('leaves the inline rename input transparent over the sidebar column', () => {
    expect(declarations(ROWS, '.renameInput').get('background')).toBe('transparent')
    expect(declarations(ROWS, '.renameInput').get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
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

  it('draws the mode toggle like the workbench segmented control: hairline track, alpha selection', () => {
    const track = declarations(PREVIEW, '.modeToggle')
    expect(track.has('background')).toBe(false)
    expect(track.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(declarations(PREVIEW, '.modeToggle button').get('background')).toBe('transparent')
    expect(declarations(PREVIEW, '.modeToggle button[data-active]').get('background')).toBe('var(--dsw-alias-interactive-bg-active)')
  })

  it('washes a removed diff line instead of filling it with the solid error color its text uses', () => {
    const removed = declarations(PREVIEW, ".diffPreview span[data-kind='delete']")
    expect(removed.get('color')).toBe('var(--dsw-alias-state-error-primary)')
    expect(removed.get('background')).toBe('color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)')
  })
})
