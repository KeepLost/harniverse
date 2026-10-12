/**
 * Models section stylesheet contract, asserted against the CSS text on disk.
 *
 * The section paints in both themes, and a `--dsw-*` name the theme does not
 * declare fails silently: the browser takes the `var()` fallback, so the sheet
 * still renders and only the dark theme looks wrong. Checking the names against
 * the sheet that declares them is what turns that into a test failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build.
// Every theme sheet, not just the platform tokens: font and scrollbar
// variables are declared in siblings, and a gate reading one file would call
// their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/** The declarations of one top-level rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`ModelsSection.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/** Every component source in the package, by file name. */
function clientSources(): { name: string; text: string }[] {
  return readdirSync(fileURLToPath(new URL('../src/client/', import.meta.url)))
    .filter(name => name.endsWith('.tsx'))
    .map(name => ({
      name,
      text: readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8'),
    }))
}

describe('ModelsSection theme styles', () => {
  it('names only theme variables the token sheet defines', () => {
    // A `--dsw-*` name the sheet never declares is not a near miss: it silently
    // resolves to whatever literal sits in its fallback slot, which is how this
    // section stayed light under the dark theme before. Undeclared names have
    // no fallback at all and inherit, so both spellings must fail here.
    // Every theme-variable prefix the sheets actually use, not just `--dsw-`:
    // a `--dsh-` name reads as a plausible sibling and would otherwise slip
    // past this gate into a fallback literal.
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    // A missing `}` on an `@media` block is not a parse error: every rule after
    // it silently becomes conditional, and the whole fetch dialog once painted
    // unstyled for anyone whose system does not ask for reduced motion. Nothing
    // downstream reports this — the sheet loads and the classes still attach.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })

  it('separates the row card from the editor it expands into', () => {
    // `bg-layer-3` and `bg-module-platform` both resolve to neutral-bluish-800
    // under the dark theme, so filling the row with either erases the nested
    // editor's boundary. The row is outlined; the fill is the editor's alone.
    expect(block('.editor')).toContain('background: var(--dsw-alias-bg-module-platform)')
    expect(block('.rowCard')).toContain('border: 1px solid var(--dsw-alias-border-l2)')
    expect(block('.rowCard')).not.toMatch(/\bbackground\s*:/)
  })

  it('draws every dropdown through the shared Select atom', () => {
    // A raw `<select>` falls back to the OS box and arrow: the atom is what
    // carries the control height, radius, border, chevron, and focus ring, and
    // a hand-rolled one drifts from every other dropdown on the page.
    const raw = clientSources()
      .filter(({ text }) => /<select\b/.test(text))
      .map(({ name }) => name)
    expect(raw).toEqual([])
  })

  it('lays dropdowns out without a width of their own, so the row decides', () => {
    // The atom owns no width. A field-column dropdown fills its column up to
    // 240px; the provider/model/effort pickers of one target row share the line
    // and shrink before they wrap.
    expect(block('.selectField')).toMatch(/width: 100%;[\s\S]*max-width: 240px/)
    expect(block('.targetSelect')).toMatch(/flex: 1 1 140px;[\s\S]*min-width: 0;[\s\S]*max-width: 240px/)
  })

  it('never leaves a modifier class without its base class', () => {
    // `.iconButtonDanger` holds only a hover tint and `.credentialDot*` only a
    // fill: used alone they paint nothing of the control's geometry.
    const pairings: readonly (readonly [modifier: string, base: string])[] = [
      ['iconButtonDanger', 'iconButton'],
      ['credentialDotConfigured', 'credentialDot'],
      ['credentialDotMissing', 'credentialDot'],
    ]
    const orphans = clientSources().flatMap(({ name, text }) => pairings.flatMap(([modifier, base]) =>
      text.split('\n')
        .filter(line => line.includes(`styles['${modifier}']`) && !line.includes(`styles['${base}']`))
        .map(() => `${name}: ${modifier} without ${base}`)))
    expect(orphans).toEqual([])
  })

  it('never falls back to a literal colour', () => {
    // A token that resolves is never the problem; an undeclared one takes this
    // branch, and a literal here is a single colour for both themes.
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })
})
