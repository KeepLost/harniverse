/** The skin seams: tokens a skin rebinds default to the opaque aliases they replace and to no filter. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const STYLES = new URL('../src/styles/', import.meta.url)
const seamsCss = readFileSync(new URL('skin-seams.css', STYLES), 'utf8')
const platformCss = readFileSync(new URL('design-platform.css', STYLES), 'utf8')

/** One rule: the at-rule condition it sits under (if any), its selector, and its declarations. */
interface Rule { supports: string | undefined; selector: string; declarations: Map<string, string> }

/** Declarations of a rule body, as a name → value map. */
function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '))
  return found
}

/** The rules of the seam sheet: top-level ones and those nested in one `@supports` block. */
function rulesOf(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const guarded = /@supports\s*([^{]+)\{\s*([^{}]+)\{([^{}]*)\}\s*\}/g
  const rest = stripped.replace(guarded, (_all, supports: string, selector: string, body: string) => {
    rules.push({ supports: supports.trim(), selector: selector.trim(), declarations: declarations(body) })
    return ''
  })
  for (const match of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ supports: undefined, selector: match[1]!.trim(), declarations: declarations(match[2]!) })
  }
  return rules
}

describe('skin-seams.css', () => {
  const rules = rulesOf(seamsCss)
  const seams = rules.find(rule => rule.supports === undefined)!.declarations
  const companions = rules.find(rule => rule.supports !== undefined)!

  it('declares every seam on body, never on :root, so aliases resolve where they are defined', () => {
    expect(rules.map(rule => rule.selector)).toEqual(['body', 'body'])
    expect(seamsCss).not.toMatch(/:root\s*[,{]/)
  })

  it('defaults each surface to the opaque alias it replaces', () => {
    expect(Object.fromEntries([...seams].filter(([name]) => name.startsWith('--dsw-surface-')))).toEqual({
      '--dsw-surface-pane': 'var(--dsw-alias-bg-base)',
      '--dsw-surface-sidebar': 'var(--dsw-specific-sidebar-fill)',
      '--dsw-surface-composer': 'var(--dsw-specific-input-major)',
      '--dsw-surface-popover': 'var(--dsw-specific-menu)',
      '--dsw-surface-dialog': 'var(--dsw-alias-bg-layer-2)',
    })
  })

  it('defaults every material to no backdrop filter', () => {
    const materials = [...seams].filter(([name]) => name.startsWith('--dsw-material-'))
    expect(materials.map(([name]) => name).sort()).toEqual([
      '--dsw-material-composer-filter', '--dsw-material-dialog-filter', '--dsw-material-panel-filter', '--dsw-material-popover-filter',
    ])
    for (const [, value] of materials) expect(value).toBe('none')
  })

  it('declares the opaque companions of the pane, sidebar, popover, and dialog behind a relative-colour guard', () => {
    expect(companions.supports).toBe('(color: rgb(from red r g b / 1))')
    expect(Object.fromEntries(companions.declarations)).toEqual({
      '--dsw-opaque-pane': 'rgb(from var(--dsw-alias-bg-base) r g b / 1)',
      '--dsw-opaque-sidebar': 'rgb(from var(--dsw-specific-sidebar-fill) r g b / 1)',
      '--dsw-opaque-popover': 'rgb(from var(--dsw-specific-menu) r g b / 1)',
      '--dsw-opaque-dialog': 'rgb(from var(--dsw-alias-bg-layer-2) r g b / 1)',
    })
  })

  it('strips each companion from the alias its surface defaults to, with an explicit alpha of 1', () => {
    // Alpha omitted would keep the alias's own alpha (Chromium computes 0.85 for a 0.85 alias), so `/ 1` is the contract.
    for (const [name, value] of companions.declarations) {
      const surface = seams.get(name.replace('--dsw-opaque-', '--dsw-surface-'))
      expect(value, name).toBe(`rgb(from ${surface} r g b / 1)`)
    }
    expect(companions.declarations.has('--dsw-opaque-composer')).toBe(false)
  })

  it('keeps relative colour syntax and the companions out of the unguarded rule', () => {
    expect([...seams.values()].some(value => value.includes('from '))).toBe(false)
    expect([...seams.keys()].some(name => name.startsWith('--dsw-opaque-'))).toBe(false)
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
