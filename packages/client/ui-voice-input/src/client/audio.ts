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

/** Injectable browser container so suites can drive the capture without one. */
export interface MediaContainer {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createRecorder(stream: MediaStream): { stop(): Promise<Blob>; destroy(): void }
  decode(data: ArrayBuffer): Promise<AudioBuffer>
}

/** One microphone recording owned by its caller. */
export interface Recording {
  /** Acquire the microphone and begin recording. */
  start(): Promise<void>
  /** Stop recording and re-encode the capture as canonical WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Release the stream and recorder without producing audio. */
  dispose(): void
}

/**
 * Create one microphone capture bound to a media container.
 * @param container - browser media APIs.
 * @returns the recording handle.
 */
export function createRecording(container: MediaContainer): Recording {
  let recorder: { stop(): Promise<Blob>; destroy(): void } | undefined
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
    },
    async stop(): Promise<Uint8Array> {
      const active = recorder
      if (active === undefined) throw new RecordingError('stopped')
      recorder = undefined
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
    },
  }
}
