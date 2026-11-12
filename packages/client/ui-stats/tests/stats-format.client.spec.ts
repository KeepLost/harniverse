/**
 * Formatting contracts: compact counts, durations, speeds, ratios, and
 * bounded previews are deterministic strings.
 */
import { describe, expect, it } from 'vitest'
import {
  formatCount, formatMs, formatPercent, formatTps, previewText,
} from '../src/client/stats-format.ts'

describe('stats formatting', () => {
  it('formats counts exactly below ten thousand and compact above', () => {
    expect(formatCount(null)).toBe('—')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(9_999)).toBe('9999')
    expect(formatCount(12_340)).toBe('12.3k')
    expect(formatCount(10_000)).toBe('10k')
    expect(formatCount(1_234_567)).toBe('1.2M')
  })

  it('formats durations across ms, s, and minutes', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(499.6)).toBe('500 ms')
    expect(formatMs(1_234)).toBe('1.23 s')
    expect(formatMs(62_000)).toBe('1m 02s')
  })

  it('formats decode speed and ratios', () => {
    expect(formatTps(null, 1_000)).toBe('—')
    expect(formatTps(100, null)).toBe('—')
    expect(formatTps(100, 0)).toBe('—')
    expect(formatTps(120, 2_000)).toBe('60.0 t/s')
    expect(formatPercent(null, 100)).toBe('—')
    expect(formatPercent(0, 0)).toBe('—')
    expect(formatPercent(2_500, 10_000)).toBe('25%')
  })

  it('collapses and bounds previews', () => {
    expect(previewText('  a \n b ')).toBe('a b')
    expect(previewText('   ')).toBeNull()
    expect(previewText('x'.repeat(200))).toHaveLength(120)
    expect(previewText('x'.repeat(200))?.endsWith('…')).toBe(true)
    expect(previewText('abcdef', 4)).toBe('abc…')
  })
})
