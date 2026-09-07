/** Session format-version classification: the four-value face over stored headers. */
import { describe, expect, it } from 'vitest'
import { classifySessionFormatVersion } from '../src/format-classification.ts'

describe('classifySessionFormatVersion', () => {
  it('classifies the supported version as current', () => {
    expect(classifySessionFormatVersion(0)).toBe('current')
  })

  it('classifies every version above the supported one as unsupported', () => {
    expect(classifySessionFormatVersion(1)).toBe('unsupported')
    expect(classifySessionFormatVersion(2)).toBe('unsupported')
  })

  it('classifies non-version values as malformed', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', undefined, null, 2 ** 53]) {
      expect(classifySessionFormatVersion(version)).toBe('malformed')
    }
  })

  it('classifies an older generation as migration-required through the injected current version', () => {
    // v0 is the oldest generation this build stamps, so the default call can
    // never produce this class yet; the injected face pins the semantics for
    // the first future bump.
    expect(classifySessionFormatVersion(2, 3)).toBe('migration-required')
    expect(classifySessionFormatVersion(0, 3)).toBe('migration-required')
    expect(classifySessionFormatVersion(3, 3)).toBe('current')
    expect(classifySessionFormatVersion(4, 3)).toBe('unsupported')
    expect(classifySessionFormatVersion(-1, 3)).toBe('malformed')
  })
})
