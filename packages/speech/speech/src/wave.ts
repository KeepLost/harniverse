/** Canonical PCM16 WAV intake validation, shared by providers and the wire boundary. */

/** Header parameters a canonical recording must match; every field has a fixed default. */
export interface WaveExpectations {
  /** Required PCM sample rate in hertz; defaults to 16000. */
  readonly sampleRate?: number
  /** Required channel count; defaults to 1 (mono). */
  readonly channels?: number
  /** Maximum admitted recording duration in seconds. */
  readonly maxDurationSeconds: number
}

/** Fixed bytes of the canonical 44-byte RIFF header this validator admits. */
const HEADER_BYTES = 44

function ascii(audio: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(audio[start + index] as number)
  return out
}

function uint16(audio: Uint8Array, offset: number): number {
  return (audio[offset] as number) | ((audio[offset + 1] as number) << 8)
}

function uint32(audio: Uint8Array, offset: number): number {
  return ((audio[offset] as number) | ((audio[offset + 1] as number) << 8)
    | ((audio[offset + 2] as number) << 16) | ((audio[offset + 3] as number) << 24)) >>> 0
}

/**
 * Read one canonical PCM16 WAV recording, rejecting every non-canonical or
 * inconsistent header as well as recordings past the duration limit. Canonical
 * means: 44-byte RIFF header, one 16-byte `fmt ` chunk (PCM, uncompressed),
 * one trailing `data` chunk, sizes exactly consistent with the byte length.
 * @param audio - decoded wire bytes.
 * @param expectations - sample rate, channels, and duration ceiling; sample
 * rate and channels default to the provider-canonical 16 kHz mono.
 * @returns the recording duration in seconds.
 * @throws `Error` naming the violated expectation.
 */
export function validateWav(audio: Uint8Array, expectations: WaveExpectations): number {
  const sampleRate = expectations.sampleRate ?? 16_000
  const channels = expectations.channels ?? 1
  const byteRate = sampleRate * channels * 2
  const blockAlign = channels * 2
  const reasons: string[] = []
  if (audio.length < HEADER_BYTES) reasons.push('shorter than the 44-byte canonical header')
  else {
    if (ascii(audio, 0, 4) !== 'RIFF') reasons.push('missing RIFF magic')
    if (ascii(audio, 8, 4) !== 'WAVE') reasons.push('missing WAVE magic')
    if (ascii(audio, 12, 4) !== 'fmt ') reasons.push('missing fmt chunk')
    if (uint32(audio, 16) !== 16) reasons.push('fmt chunk is not exactly 16 bytes')
    if (uint16(audio, 20) !== 1) reasons.push('audio format is not uncompressed PCM')
    if (uint16(audio, 22) !== channels) reasons.push(`channel count is not ${String(channels)}`)
    if (uint32(audio, 24) !== sampleRate) reasons.push(`sample rate is not ${String(sampleRate)}`)
    if (uint32(audio, 28) !== byteRate) reasons.push('byte rate contradicts the declared format')
    if (uint16(audio, 32) !== blockAlign) reasons.push('block align contradicts the declared format')
    if (uint16(audio, 34) !== 16) reasons.push('bits per sample is not 16')
    if (ascii(audio, 36, 4) !== 'data') reasons.push('missing data chunk')
    if (uint32(audio, 4) !== audio.length - 8) reasons.push('RIFF size contradicts the byte length')
    if (uint32(audio, 40) !== audio.length - HEADER_BYTES) reasons.push('data size contradicts the byte length')
    if ((audio.length - HEADER_BYTES) % 2 !== 0) reasons.push('odd PCM byte count')
  }
  if (reasons.length > 0) throw new Error(`Audio must be a canonical ${String(sampleRate)} Hz ${String(channels)}-channel PCM16 WAV recording: ${reasons.join('; ')}`)
  const seconds = (audio.length - HEADER_BYTES) / byteRate
  if (seconds > expectations.maxDurationSeconds) {
    throw new Error(`Audio exceeds ${String(expectations.maxDurationSeconds)} seconds`)
  }
  return seconds
}
