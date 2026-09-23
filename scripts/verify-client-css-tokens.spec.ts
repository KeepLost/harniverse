import { describe, expect, it } from 'vitest'
import { findCssTokenViolations } from './verify-client-css-tokens.ts'

describe('findCssTokenViolations', () => {
  it('guards governed custom-property names containing underscores', () => {
    const violations = findCssTokenViolations('fixture.css', `
.fixture {
  --dsw-missing_token: red;
  color: var(--dsw-missing_token);
}
`, new Set())

    expect(violations).toEqual([
      { file: 'fixture.css', line: 3, token: '--dsw-missing_token', kind: 'declaration' },
      { file: 'fixture.css', line: 4, token: '--dsw-missing_token', kind: 'reference' },
    ])
  })

  it('rejects a fallback standing in for an undefined governed token', () => {
    const violations = findCssTokenViolations('fixture.css', `
.fixture {
  background: var(--dsw-alias-terminal-bg, #000);
  font-family: var(--dsw-alias-font-mono, monospace);
}
`, new Set())

    expect(violations).toEqual([
      { file: 'fixture.css', line: 3, token: '--dsw-alias-terminal-bg', kind: 'fallback' },
      { file: 'fixture.css', line: 4, token: '--dsw-alias-font-mono', kind: 'fallback' },
    ])
  })

  it('accepts a fallback behind a defined token', () => {
    const violations = findCssTokenViolations('fixture.css', `
.fixture {
  background: var(--dsw-alias-bg-base, #fff);
}
`, new Set(['--dsw-alias-bg-base']))

    expect(violations).toEqual([])
  })
})
