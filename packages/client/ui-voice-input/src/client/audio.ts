/**
 * Microphone capture over getUserMedia + MediaRecorder: browsers hand the
 * recorder webm/opus bytes, so the capture decodes through AudioContext and
 * re-encodes as canonical 16 kHz mono PCM16 WAV before transcription.
 */

import { downmixToMono, encodeWav16kMono, resampleTo16k } from './wav.ts'

/** The named ways one capture attempt failed. */
export type RecordingErrorKind = 'denied' | 'unsupported' | 'no-data' | 'decode' | 'stopped'

/** One capture attempt failed in a way the UI can name. */
export class RecordingError extends Error {
  /** Machine-readable failure kind for guidance copy. */
  readonly kind: RecordingErrorKind

  constructor(kind: RecordingErrorKind) {
    super(kind)
    this.kind = kind
  }
}

/** Decode one recorded Blob into mono 16 kHz WAV bytes. */
async function decodeToWav(blob: Blob, decode: (data: ArrayBuffer) => Promise<AudioBuffer>): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer()
  const decoded = await decode(buffer)
  const planes: Float32Array[] = []
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    planes.push(decoded.getChannelData(channel))
  }
  const mono = resampleTo16k(downmixToMono(planes), decoded.sampleRate)
  return encodeWav16kMono(mono)
}

/** Live input-level probe bound to one capture's stream. */
export interface LevelTap {
  /** Fill `target` with the most recent time-domain samples. */
  read(target: Float32Array<ArrayBuffer>): void
  /** Release the probe's audio graph. */
  dispose(): void
}

/** Injectable browser container so suites can drive the capture without one. */
export interface MediaContainer {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createRecorder(stream: MediaStream): { stop(): Promise<Blob>; destroy(): void }
  decode(data: ArrayBuffer): Promise<AudioBuffer>
  /** Optional live level probe for the recording UI; absent containers report level 0. */
  createAnalyser?(stream: MediaStream): LevelTap
}

/** One microphone recording owned by its caller. */
export interface Recording {
  /** Acquire the microphone and begin recording. */
  start(): Promise<void>
  /** Stop recording and re-encode the capture as canonical WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Release the stream and recorder without producing audio. */
  dispose(): void
  /** Peak input magnitude of the latest analyser frame in [0, 1]; 0 without a tap. */
  level(): number
}

/**
 * Create one microphone capture bound to a media container.
 * @param container - browser media APIs.
 * @returns the recording handle.
 */
export function createRecording(container: MediaContainer): Recording {
  let recorder: { stop(): Promise<Blob>; destroy(): void } | undefined
  let tap: LevelTap | undefined
  return {
    async start(): Promise<void> {
      let stream: MediaStream
      try {
        stream = await container.getUserMedia({ audio: true })
      } catch (error) {
        if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
          throw new RecordingError('denied')
        }
        throw new RecordingError('unsupported')
      }
      recorder = container.createRecorder(stream)
      tap = container.createAnalyser?.(stream)
    },
    async stop(): Promise<Uint8Array> {
      const active = recorder
      if (active === undefined) throw new RecordingError('stopped')
      recorder = undefined
      tap?.dispose()
      tap = undefined
      const blob = await active.stop()
      if (blob.size === 0) throw new RecordingError('no-data')
      try {
        return await decodeToWav(blob, data => container.decode(data))
      } catch {
        throw new RecordingError('decode')
      }
    },
    dispose(): void {
      recorder?.destroy()
      recorder = undefined
      tap?.dispose()
      tap = undefined
    },
    level(): number {
      const active = tap
      if (active === undefined) return 0
      const frame = new Float32Array(2_048)
      active.read(frame)
      let peak = 0
      for (let index = 0; index < frame.length; index += 1) {
        const magnitude = Math.abs(frame[index] as number)
        if (magnitude > peak) peak = magnitude
      }
      return Math.min(1, peak)
    },
  }
}
