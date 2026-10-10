/**
 * AppFrame skin-seam contract, asserted against the CSS text on disk: the
 * docked columns paint the surface tokens (so a skin can make them
 * translucent), the covering layers keep their opaque aliases, the backdrop
 * layer sits behind the columns, and the panel glass rides a pseudo-element
 * plate rather than the columns themselves.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')

interface Rule { selectors: string[]; declarations: Map<string, string> }

/** Every rule in the sheet, comments removed, selector lists split. */
const rules: Rule[] = [...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList = '', body = '']) => ({
  selectors: selectorList.split(',').map(value => value.trim()),
  declarations: new Map(body.split(';').flatMap((part): [string, string][] => {
    const colon = part.indexOf(':')
    return colon === -1 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')]]
  })),
}))

/**
 * Declarations of the rule whose selector list contains the exact selector.
 * @param selector - exact selector text.
 * @returns the declarations, or an empty map when no rule matches.
 */
function declarations(selector: string): Map<string, string> {
  return rules.find(rule => rule.selectors.includes(selector))?.declarations ?? new Map<string, string>()
}

const SIDEBAR_PLATE = '.frame[data-backdrop]:not([data-sidebar-drawer]) .sidebarCol::before'
const DETAILS_PLATE = '.frame[data-backdrop] .detailsCol:not([data-right-drawer])::before'

describe('AppFrame.module.css surfaces', () => {
  it('paints the docked frame, sidebar, and details fills through the surface tokens', () => {
    expect(declarations('.frame').get('background')).toBe('var(--dsw-surface-pane)')
    expect(declarations('.sidebarCol').get('background')).toBe('var(--dsw-surface-sidebar)')
    expect(declarations('.detailsCol').get('background')).toBe('var(--dsw-surface-pane)')
  })

  it('keeps the covering layers on the opaque aliases', () => {
    expect(declarations('.frame[data-sidebar-drawer] .sidebarCol').get('background')).toBe('var(--dsw-specific-sidebar-fill)')
    expect(declarations('.detailsCol[data-right-drawer]').get('background')).toBe('var(--dsw-alias-bg-base)')
    expect(declarations('.centerViewLayer').get('background')).toBe('var(--dsw-alias-bg-base)')
  })
})

describe('AppFrame.module.css backdrop layer', () => {
  it('stacks behind the columns without capturing pointer events', () => {
    const backdrop = declarations('.backdrop')
    expect(backdrop.get('position')).toBe('absolute')
    expect(backdrop.get('inset')).toBe('0')
    expect(backdrop.get('z-index')).toBe('-1')
    expect(backdrop.get('overflow')).toBe('hidden')
    expect(backdrop.get('pointer-events')).toBe('none')
  })

  it('isolates the frame only while a backdrop exists', () => {
    expect(declarations('.frame[data-backdrop]').get('isolation')).toBe('isolate')
    expect(declarations('.frame').has('isolation')).toBe(false)
  })
})

describe('AppFrame.module.css panel glass', () => {
  it('puts the panel filter on a pseudo-element plate behind each docked column', () => {
    for (const plate of [SIDEBAR_PLATE, DETAILS_PLATE]) {
      const declared = declarations(plate)
      expect(declared.get('content'), plate).toBe("''")
      expect(declared.get('position'), plate).toBe('absolute')
      expect(declared.get('inset'), plate).toBe('0')
      expect(declared.get('z-index'), plate).toBe('-1')
      expect(declared.get('pointer-events'), plate).toBe('none')
      expect(declared.get('backdrop-filter'), plate).toBe('var(--dsw-material-panel-filter)')
    }
  })

  it('anchors the plates to relatively positioned docked columns only', () => {
    const anchored = declarations('.frame[data-backdrop]:not([data-sidebar-drawer]) .sidebarCol')
    expect(anchored.get('position')).toBe('relative')
    expect(declarations('.frame[data-backdrop] .detailsCol:not([data-right-drawer])').get('position')).toBe('relative')
  })

  it('never declares a backdrop-filter on an element that can hold fixed descendants', () => {
    const filtered = rules.filter(rule => rule.declarations.has('backdrop-filter')).flatMap(rule => rule.selectors)
    expect(filtered.sort()).toEqual([DETAILS_PLATE, SIDEBAR_PLATE].sort())
  })
})
