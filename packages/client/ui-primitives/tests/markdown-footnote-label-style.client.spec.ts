/**
 * Footnote label contract, asserted against the CSS text on disk: Vitest
 * proxies CSS Module lookups, so a class that no stylesheet declares still
 * resolves to a hashed name in component specs. The label heading must be
 * hidden visually (not removed from the accessibility tree) by a rule the
 * markdown module owns.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(fileURLToPath(new URL('../src/markdown/MarkdownText.module.css', import.meta.url)), 'utf8')
  .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')

describe('MarkdownText.module.css footnote label', () => {
  it('declares a visually-hidden srOnly rule that outranks the heading rules', () => {
    const rule = /\.srOnly,\s*\.markdown \.srOnly\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })
})
