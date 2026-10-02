/**
 * Pure frontend audio plumbing for the microphone control: canonical
 * 16 kHz mono PCM16 WAV encoding and browser-container byte/word helpers.
 * The encoding is a pure function over decoded samples, so suites cover it
 * without a browser.
 */

/** Bytes of the canonical 44-byte RIFF header this encoder writes. */
export const WAV_HEADER_BYTES = 44

/**
 * Encode PCM samples as one canonical 16 kHz mono PCM16 WAV recording — the
 * exact byte layout `validateWav` on the Host admits.
 * @param samples - mono 16 kHz PCM as [-1, 1] floats.
 * @returns the complete WAV bytes.
 */
export function encodeWav16kMono(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (value: string, offset: number): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text('RIFF', 0)
  view.setUint32(4, 36 + dataBytes, true)
  text('WAVE', 8)
  text('fmt ', 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text('data', 36)
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] as number))
    view.setInt16(WAV_HEADER_BYTES + index * 2, clamped < 0 ? clamped * 32_768 : clamped * 32_767, true)
  }
  return bytes
}

/**
 * Base64 of binary data without growth beyond what the output needs.
 * @param bytes - binary data.
 * @returns the canonical base64 form (no line wrapping).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8_000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/**
 * Mix N channels down to mono by averaging, the browser containers' standard
 * downmix for speech capture.
 * @param planes - one Float32Array per channel, all of equal length.
 * @returns the mono mix.
 */
export function downmixToMono(planes: readonly Float32Array[]): Float32Array {
  const [first] = planes
  if (planes.length === 1) return first as Float32Array
  const length = first?.length ?? 0
  const mono = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    for (const plane of planes) sum += plane[index] as number
    mono[index] = sum / planes.length
  }
  return mono
}

/**
 * Resample mono PCM to 16 kHz with linear interpolation.
 * @param samples - source samples at `sourceRate`.
 * @param sourceRate - the samples' sample rate.
 * @returns resampled 16 kHz samples.
 */
export function resampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16_000) return samples
  const ratio = sourceRate / 16_000
  const length = Math.floor(samples.length / ratio)
  const resampled = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, samples.length - 1)
    const weight = position - left
    resampled[index] = (samples[left] as number) * (1 - weight) + (samples[right] as number) * weight
  }
  return resampled
}
