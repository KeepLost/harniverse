import { describe, expect, it } from 'vitest'
import { findCssTokenViolations } from './verify-client-css-tokens.ts'

describe('findCssTokenViolations', () => {
  it('guards governed custom-property names containing underscores', () => {
    const violations = findCssTokenViolations('fixture.css', `
.fixture {
  --dsw-missing_token: red;
  color: var(--dsw-missing_token);
  outline-color: var(--dsw-missing_token, red);
}
`, new Set())

    expect(violations).toEqual([
      { file: 'fixture.css', line: 3, token: '--dsw-missing_token', kind: 'declaration' },
      { file: 'fixture.css', line: 4, token: '--dsw-missing_token', kind: 'reference' },
    ])
  })
})
