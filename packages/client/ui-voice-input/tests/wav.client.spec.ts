/**
 * Canonical WAV encoding: the pure frontend encoder's output layout — the
 * exact bytes the Host's `validateWav` admits — plus downmix and resample
 * math, covered without a browser.
 */

import { describe, expect, it } from 'vitest'
import { bytesToBase64, downmixToMono, encodeWav16kMono, resampleTo16k, wavAmplitudeStats } from '../src/client/wav.ts'

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[start + index] as number)
  return out
}

describe('encodeWav16kMono', () => {
  it('writes the canonical 44-byte PCM16 header with consistent sizes', () => {
    const samples = new Float32Array(100)
    const wav = encodeWav16kMono(samples)
    expect(wav.length).toBe(244)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(new DataView(wav.buffer).getUint32(4, true)).toBe(wav.length - 8)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    const view = new DataView(wav.buffer)
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(wav.length - 44)
  })

  it('clamps and scales samples onto the int16 range', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 2, -2])
    const wav = encodeWav16kMono(samples)
    const view = new DataView(wav.buffer)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(16_383)
    expect(view.getInt16(48, true)).toBe(-16_384)
    expect(view.getInt16(50, true)).toBe(32_767)
    expect(view.getInt16(52, true)).toBe(-32_768)
  })
})

describe('wavAmplitudeStats', () => {
  it('summarizes duration, peak, and rms over the PCM payload', () => {
    const stats = wavAmplitudeStats(encodeWav16kMono(Float32Array.from([0.5, -0.25, 0.25, -0.5])))
    expect(stats).toMatchObject({ durationMs: 0.25, peak: 0.5 })
    // RMS over the quantized samples: (0.25 + 0.0625 + 0.0625 + 0.25) / 4.
    expect(stats.rms).toBeCloseTo(Math.sqrt(0.15625), 2)
  })

  it('answers a payload-less recording with zeroed stats', () => {
    expect(wavAmplitudeStats(encodeWav16kMono(new Float32Array(0)))).toEqual({ durationMs: 0, peak: 0, rms: 0 })
  })
})

describe('downmixToMono', () => {
  it('returns the single plane unchanged and averages multi-channel planes', () => {
    const mono = new Float32Array([1, 2, 3])
    expect(downmixToMono([mono])).toBe(mono)
    const left = new Float32Array([-1, 1])
    const right = new Float32Array([1, 3])
    expect([...downmixToMono([left, right])]).toEqual([0, 2])
  })

  it('answers an empty plane list with an empty mix', () => {
    expect(downmixToMono([])).toEqual(new Float32Array(0))
  })
})

describe('resampleTo16k', () => {
  it('passes through 16 kHz and decimates higher rates', () => {
    const passthrough = new Float32Array(4)
    expect(resampleTo16k(passthrough, 16_000)).toBe(passthrough)
    const at48k = new Float32Array([0, 3, 6, 9, 12, 15])
    expect([...resampleTo16k(at48k, 48_000)]).toEqual([0, 9])
  })
})

describe('bytesToBase64', () => {
  it('produces canonical base64 of its input', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251])
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(0, 1, 2, 250, 251)))
  })
})
