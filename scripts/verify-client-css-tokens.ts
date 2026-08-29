/**
 * Reject client CSS Module declarations or references to design-system custom
 * properties that no theme sheet defines.
 *
 * `var(--dsw-x)` without a fallback resolves to nothing when `--dsw-x` is
 * undefined: the declaration is dropped as invalid at computed-value time, so a
 * colour silently inherits and a `border: 1px solid var(--undefined)` shorthand
 * disappears entirely. Neither the bundler nor a browser reports it, and
 * light-theme inheritance can hide the fault until a dark skin exposes it.
 *
 * Governed prefixes are the shared design-system layers: `--dsw-*` (tokens) and
 * `--ds-*` (motion, upstream base). Feature-local variables use the `--dsh-*`
 * (product) and `--dsl-*` (primitive-local) prefixes and are out of scope,
 * since their definitions live beside their consumers.
 *
 * A reference carrying a fallback (`var(--dsw-x, 12px)`) is permitted: it is a
 * deliberate optional read with a defined outcome.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-css-tokens.ts
 */

import { globSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const THEME_STYLES = join(root, 'packages/client/ui-theme/src/styles')

/** Custom-property prefixes owned by the shared theme layer. */
const GOVERNED = /^--(?:dsw|ds)-/

/** Directories searched for CSS that consumes theme tokens. */
const SEARCH_ROOTS = ['packages', 'apps']

/** One undefined governed reference. */
interface Violation { file: string; line: number; token: string; kind: 'declaration' | 'reference' }

/** Remove comments while retaining newlines so diagnostics keep source lines. */
function withoutComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//gu, comment => comment.replaceAll(/[^\n]/gu, ' '))
}

/** Remove CSS strings after comments while retaining newlines for diagnostics. */
function withoutStrings(text: string): string {
  return text.replaceAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gu, string => string.replaceAll(/[^\n]/gu, ' '))
}

function withoutCssNoise(text: string): string {
  return withoutComments(withoutStrings(text))
}

/**
 * Custom properties the theme sheets define.
 * @returns every declared property name, including the `--` prefix.
 */
function definedTokens(): Set<string> {
  const defined = new Set<string>()
  for (const rel of globSync('*.css', { cwd: THEME_STYLES })) {
    const text = withoutCssNoise(readFileSync(join(THEME_STYLES, rel), 'utf8'))
    for (const [, name] of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      if (name !== undefined) defined.add(name)
    }
  }
  return defined
}

/**
 * CSS files that may consume theme tokens.
 * @returns repository-relative paths with `/` separators, theme sheets excluded.
 */
function consumerStylesheets(): string[] {
  const found: string[] = []
  for (const base of SEARCH_ROOTS) {
    for (const rel of globSync('**/*.css', {
      cwd: join(root, base),
      exclude: path => /(?:^|\/)(?:node_modules|lib|dist)(?:\/|$)/.test(path.split(sep).join('/')),
    })) {
      const path = `${base}/${rel.split(sep).join('/')}`
      if (path.includes('/ui-theme/src/styles/')) continue
      found.push(path)
    }
  }
  return found.sort()
}

/**
 * Find undefined governed tokens in stylesheet content.
 * @param path - repository-relative stylesheet path for diagnostics.
 * @param text - stylesheet source.
 * @param defined - property names the theme sheets declare.
 * @returns one violation per undefined declaration or fallback-less reference.
 */
export function findCssTokenViolations(path: string, text: string, defined: Set<string>): Violation[] {
  const violations: Violation[] = []
  const lines = withoutCssNoise(text).split('\n')
  for (const [index, line = ''] of lines.entries()) {
    for (const [, name] of line.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      if (name !== undefined && GOVERNED.test(name) && !defined.has(name)) {
        violations.push({ file: path, line: index + 1, token: name, kind: 'declaration' })
      }
    }
  }
  const source = lines.join('\n')
  for (const match of source.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/gu)) {
    const token = match[1]
    if (token === undefined || !GOVERNED.test(token)) continue
    if (match[2] === ',') continue
    if (defined.has(token)) continue
    const line = source.slice(0, match.index).split('\n').length
    violations.push({ file: path, line, token, kind: 'reference' })
  }
  return violations
}

function checkStylesheet(path: string, defined: Set<string>): Violation[] {
  return findCssTokenViolations(path, readFileSync(join(root, path), 'utf8'), defined)
}

function main(): void {
  const defined = definedTokens()
  const violations = consumerStylesheets().flatMap(path => checkStylesheet(path, defined))

  if (violations.length > 0) {
    console.error(`verify-client-css-tokens: ${violations.length} undefined governed token declaration(s) or reference(s):`)
    for (const violation of violations) {
      const detail = violation.kind === 'declaration' ? `${violation.token}:` : `var(${violation.token})`
      console.error(`  ${violation.file}:${violation.line} -> ${detail}`)
    }
    console.error('Map each reference onto a token defined in packages/client/ui-theme/src/styles,')
    console.error('or give it an explicit fallback when the read is deliberately optional.')
    process.exit(1)
  }
  console.log(`verify-client-css-tokens: ${String(defined.size)} theme tokens, every client reference resolves.`)
}

if (import.meta.main) main()
