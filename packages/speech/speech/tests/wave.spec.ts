import { describe, expect, it } from 'vitest'
import { validateWav } from '../src/wave.ts'

/** Canonical 44-byte header for one PCM16 WAV recording. */
function wav(samples: number, options: { sampleRate?: number; channels?: number } = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000
  const channels = options.channels ?? 1
  const dataBytes = samples * channels * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const write = (text: string, offset: number): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  write('RIFF', 0)
  view.setUint32(4, 36 + dataBytes, true)
  write('WAVE', 8)
  write('fmt ', 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  write('data', 36)
  view.setUint32(40, dataBytes, true)
  return bytes
}

describe('validateWav', () => {
  it('admits a canonical 16 kHz mono recording and reports its duration', () => {
    const recording = wav(16_000)
    expect(validateWav(recording, { maxDurationSeconds: 2 })).toBe(1)
  })

  it('admits a non-default sample rate and channel count when expected', () => {
    const stereo = wav(11_025, { sampleRate: 22_050, channels: 2 })
    expect(validateWav(stereo, { sampleRate: 22_050, channels: 2, maxDurationSeconds: 2 })).toBeCloseTo(0.5, 5)
  })

  it('rejects the same bytes against mismatched expectations', () => {
    const recording = wav(100)
    expect(() => validateWav(recording, { sampleRate: 8_000, maxDurationSeconds: 2 })).toThrow('sample rate is not 8000')
    expect(() => validateWav(recording, { channels: 2, maxDurationSeconds: 2 })).toThrow('channel count is not 2')
  })

  it('rejects every broken header with the violated expectation named', () => {
    const cases: readonly [string, (bytes: Uint8Array) => Uint8Array, string][] = [
      ['truncated', () => wav(100).slice(0, 10), 'shorter than the 44-byte canonical header'],
      ['RIFF magic', (bytes) => { bytes.set([0, 0, 0, 0], 0); return bytes }, 'missing RIFF magic'],
      ['WAVE magic', (bytes) => { bytes.set([0, 0, 0, 0], 8); return bytes }, 'missing WAVE magic'],
      ['fmt chunk id', (bytes) => { bytes.set([0, 0, 0, 0], 12); return bytes }, 'missing fmt chunk'],
      ['fmt chunk size', (bytes) => { new DataView(bytes.buffer).setUint32(16, 18, true); return bytes }, 'fmt chunk is not exactly 16 bytes'],
      ['compressed format', (bytes) => { new DataView(bytes.buffer).setUint16(20, 6, true); return bytes }, 'audio format is not uncompressed PCM'],
      ['sample rate', (bytes) => { new DataView(bytes.buffer).setUint32(24, 8_000, true); return bytes }, 'sample rate is not 16000'],
      ['byte rate', (bytes) => { new DataView(bytes.buffer).setUint32(28, 12_345, true); return bytes }, 'byte rate contradicts the declared format'],
      ['block align', (bytes) => { new DataView(bytes.buffer).setUint16(32, 4, true); return bytes }, 'block align contradicts the declared format'],
      ['bit depth', (bytes) => { new DataView(bytes.buffer).setUint16(34, 8, true); return bytes }, 'bits per sample is not 16'],
      ['data chunk id', (bytes) => { bytes.set([0, 0, 0, 0], 36); return bytes }, 'missing data chunk'],
      ['RIFF size', (bytes) => { new DataView(bytes.buffer).setUint32(4, 999, true); return bytes }, 'RIFF size contradicts the byte length'],
      ['data size', (bytes) => { new DataView(bytes.buffer).setUint32(40, 999, true); return bytes }, 'data size contradicts the byte length'],
    ]
    for (const [name, breakIt, expectation] of cases) {
      expect(() => validateWav(breakIt(wav(100)), { maxDurationSeconds: 2 }), name).toThrow(expectation)
    }
  })

  it('rejects an odd PCM byte count', () => {
    const recording = new Uint8Array(wav(100))
    const truncated = recording.slice(0, recording.length - 1)
    expect(() => validateWav(truncated, { maxDurationSeconds: 2 })).toThrow('odd PCM byte count')
  })

  it('rejects a recording past the duration ceiling', () => {
    const recording = wav(32_001)
    expect(() => validateWav(recording, { maxDurationSeconds: 2 })).toThrow('Audio exceeds 2 seconds')
    expect(validateWav(recording, { maxDurationSeconds: 3 })).toBeCloseTo(2.0000625, 5)
  })
})
