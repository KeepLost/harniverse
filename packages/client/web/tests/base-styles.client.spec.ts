/**
 * Shell stylesheet contract, asserted against the CSS and entry text on disk:
 * every theme sheet a shell sheet names exists, the token sheets reach BOTH
 * documents (the authentication document renders before any plugin bundle, so a
 * sheet reachable only through the app entry would leave it unstyled), and
 * scrollbar.css lands after the token sheet it reads.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'

/**
 * Read one file from the shell's src directory.
 * @param name - file name under `packages/client/web/src`.
 * @returns the file text.
 */
function shellSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8')
}

const documentCss = shellSource('document.css')
const baseCss = shellSource('base.css')
const authCss = shellSource('auth.css')
const bootEntry = shellSource('boot.tsx')
const authEntry = shellSource('AuthenticationGate.tsx')
const themeManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../ui-theme/package.json', import.meta.url)), 'utf8'),
) as { exports: Record<string, string>; files: string[] }

/**
 * Import specifiers of the sheet, in source order. Quote style and surrounding
 * whitespace are normalized away.
 * @param css - stylesheet text.
 * @returns each `@import` target in the order the sheet lists it.
 */
function importOrder(css: string): string[] {
  // The destructuring default only satisfies noUncheckedIndexedAccess; the
  // group is unconditional in the pattern.
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map(([, specifier = '']) => specifier)
}

/**
 * Resolve a `<package>/styles/<file>` specifier to its source path for a
 * clean-tree test. The package build copies these sheets to their public
 * `lib/styles` export.
 * @param specifier - import specifier from a shell sheet.
 * @returns absolute path of the file the specifier names.
 */
function resolveThemeSheet(specifier: string): string {
  const name = specifier.slice(`${THEME_PACKAGE}/styles/`.length)
  return fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url))
}

/**
 * Index of a TypeScript entry's side-effect stylesheet import.
 * @param entry - entry source text.
 * @param name - sheet file name.
 * @returns character offset of the import, or -1 when absent.
 */
function sheetImportIndex(entry: string, name: string): number {
  return entry.indexOf(`import './${name}'`)
}

const documentImports = importOrder(documentCss)
const baseImports = importOrder(baseCss)

describe('web shell stylesheets', () => {
  it('publishes theme sheets from the built artifact plane', () => {
    expect(themeManifest.exports['./styles/*']).toBe('./lib/styles/*')
    expect(themeManifest.files).toContain('lib/styles')
  })

  it('imports every sheet from the theme package and each one exists', () => {
    const specifiers = [...documentImports, ...baseImports]
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier.startsWith(`${THEME_PACKAGE}/styles/`), specifier).toBe(true)
      expect(existsSync(resolveThemeSheet(specifier)), specifier).toBe(true)
    }
  })

  it('keeps the authentication sheet self-contained', () => {
    // The document sheet is imported from the entry, not from here: sharing one
    // module keeps the token bytes in the chunk both documents descend from
    // instead of inlining them into each sheet.
    expect(importOrder(authCss)).toEqual([])
  })

  it('carries the token sheets into both shell documents', () => {
    // The regression this guards: with the token sheets reachable only through
    // base.css, the authentication document loaded no CSS at all — its own
    // rules rode a chunk that arrives after authentication succeeds.
    expect(documentImports).toContain(`${THEME_PACKAGE}/styles/design-platform.css`)
    for (const entry of [bootEntry, authEntry]) {
      expect(sheetImportIndex(entry, 'document.css')).toBeGreaterThanOrEqual(0)
    }
    expect(sheetImportIndex(authEntry, 'auth.css')).toBeGreaterThan(sheetImportIndex(authEntry, 'document.css'))
  })

  it('loads the scrollbar sheet after the token sheet it reads', () => {
    // scrollbar.css binds tokens design-platform.css declares, and the two now
    // sit in different sheets — the entry's import order is what keeps the
    // dependency direction, so assert it there.
    expect(documentImports).toContain(`${THEME_PACKAGE}/styles/design-platform.css`)
    expect(baseImports).toContain(`${THEME_PACKAGE}/styles/scrollbar.css`)
    expect(sheetImportIndex(bootEntry, 'base.css'))
      .toBeGreaterThan(sheetImportIndex(bootEntry, 'document.css'))
  })
})
