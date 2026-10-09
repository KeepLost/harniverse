import { describe, expect, it } from 'vitest'
import { formatBytes, formatTime, toBase64 } from '../src/client/format.ts'

describe('session-import formatting', () => {
  it.each([
    [0, '0 B'], [1023, '1023 B'], [1536, '1.5 KiB'], [10 * 1024, '10 KiB'],
    [64 * 1024 * 1024, '64 MiB'], [3 * 1024 ** 4, '3072 GiB'],
  ])('formats %i bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it('formats local minutes without locale dependence', () => {
    const ms = new Date(2026, 9, 9, 7, 5, 59).getTime()
    expect(formatTime(ms)).toBe('2026-10-09 07:05')
  })

  it('encodes base64 across chunk boundaries', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_value, index) => index % 251)
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    expect(toBase64(new Uint8Array())).toBe('')
  })
})
