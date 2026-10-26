/**
 * Browser-local microphone preference shared by the settings picker and
 * dictation captures: device ids are browser-instance facts (each browser
 * assigns its own and may rotate them), so the selection persists beside
 * other browser state — never in the host speech settings namespace.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** An input-device choice; an empty id follows the system default microphone. */
export interface MicrophoneDevice {
  readonly id: string
  readonly label: string
}

/** localStorage key the selection persists under. */
const PERSIST_NAME = 'dsh.voice-input.microphone'

/** Whether a persisted value is a well-formed device choice. */
function isDevice(value: unknown): value is MicrophoneDevice {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { label?: unknown }).label === 'string'
}

/**
 * Restore the browser's remembered microphone selection; corrupted or
 * absent storage resolves to the system default.
 * @returns the store, persisted under the voice-input microphone key.
 */
export function createMicrophoneDeviceStore(): SnapshotStore<MicrophoneDevice> {
  return createSnapshotStore<MicrophoneDevice>({ id: '', label: '' }, {
    persist: {
      name: PERSIST_NAME,
      restore: (stored, initial) => isDevice(stored) ? stored : initial,
    },
  })
}
