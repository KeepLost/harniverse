/**
 * State chip contract, asserted against the CSS text on disk: the panel picks
 * the chip colour with a dynamic `chip_${state}` lookup, which the static CSS
 * class guard cannot resolve, and Vitest proxies CSS Module lookups, so a state
 * without a rule would render the neutral base chip unnoticed.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/TerminalPanelView.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('TerminalPanelView.module.css state chip', () => {
  it.each(['running', 'exited', 'failed'])('colours the %s chip with its own rule', (state) => {
    expect(css).toMatch(new RegExp(`\\.chip_${state}\\s*\\{[^}]*color:\\s*var\\(--dsw-alias-`))
  })
})
