/** The skin seams: tokens a skin rebinds default to the opaque aliases they replace and to no filter. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const STYLES = new URL('../src/styles/', import.meta.url)
const seamsCss = readFileSync(new URL('skin-seams.css', STYLES), 'utf8')
const platformCss = readFileSync(new URL('design-platform.css', STYLES), 'utf8')

/** Declarations of the single rule in a stylesheet, as a name → value map. */
function declarations(css: string): Map<string, string> {
  const body = /\{([\s\S]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? ''
  const found = new Map<string, string>()
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(match[1]!, match[2]!.trim())
  return found
}

describe('skin-seams.css', () => {
  const seams = declarations(seamsCss)

  it('declares every seam on body, never on :root, so aliases resolve where they are defined', () => {
    const rules = seamsCss.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    expect(rules.startsWith('body {')).toBe(true)
    expect(rules).not.toContain(':root')
  })

  it('defaults each surface to the opaque alias it replaces', () => {
    expect(Object.fromEntries([...seams].filter(([name]) => name.startsWith('--dsw-surface-')))).toEqual({
      '--dsw-surface-pane': 'var(--dsw-alias-bg-base)',
      '--dsw-surface-sidebar': 'var(--dsw-specific-sidebar-fill)',
      '--dsw-surface-composer': 'var(--dsw-specific-input-major)',
      '--dsw-surface-popover': 'var(--dsw-specific-menu)',
    })
  })

  it('defaults every material to no backdrop filter', () => {
    const materials = [...seams].filter(([name]) => name.startsWith('--dsw-material-'))
    expect(materials.map(([name]) => name).sort()).toEqual([
      '--dsw-material-composer-filter', '--dsw-material-panel-filter', '--dsw-material-popover-filter',
    ])
    for (const [, value] of materials) expect(value).toBe('none')
  })
})

describe('design-platform.css accent family', () => {
  /** Declarations of the palette rule (light or dark) that defines the accent. */
  function paletteWithAccent(selector: string): Map<string, string> {
    const stripped = platformCss.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (rule[1]!.trim() === selector && rule[2]!.includes('--dsw-accent:')) return declarations(`{${rule[2]!}}`)
    }
    throw new Error(`no ${selector} rule defines the accent`)
  }
  const palettes = [paletteWithAccent('body'), paletteWithAccent('body[data-ds-dark-theme]')]

  it('defines accent, hover, soft, and chip in both palettes', () => {
    for (const values of palettes) {
      for (const name of ['--dsw-accent', '--dsw-accent-hover', '--dsw-accent-soft', '--dsw-accent-chip']) {
        expect(values.has(name)).toBe(true)
      }
    }
  })

  it('keeps the chip tint at the pre-skin literal so the default look is unchanged', () => {
    for (const values of palettes) expect(values.get('--dsw-accent-chip')).toBe('rgba(97, 135, 216, 0.22)')
  })

  it('reads the accent from the aliases a skin must restyle together', () => {
    for (const values of palettes) {
      expect(values.get('--dsw-alias-button-info-fill')).toBe('var(--dsw-accent)')
      expect(values.get('--dsw-alias-button-info-hover')).toBe('var(--dsw-accent-hover)')
      expect(values.get('--dsw-alias-link')).toBe('var(--dsw-accent)')
      expect(values.get('--dsw-alias-state-business-primary')).toBe('var(--dsw-accent)')
      expect(values.get('--dsw-alias-state-business-tertiary')).toBe('var(--dsw-accent-soft)')
    }
  })
})
