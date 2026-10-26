// @vitest-environment jsdom
/**
 * The browser-local microphone preference: the store persists the selected
 * device beside other browser state (device ids are browser-instance facts),
 * restores a validated selection, and falls back to the system default on
 * corrupted or absent storage.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMicrophoneDeviceStore } from '../src/client/microphone-device.ts'

const KEY = 'dsh.voice-input.microphone'

afterEach(() => { window.localStorage.clear() })

describe('createMicrophoneDeviceStore', () => {
  it('starts at the system default and persists selections', () => {
    const store = createMicrophoneDeviceStore()
    expect(store.getSnapshot()).toEqual({ id: '', label: '' })
    store.set({ id: 'mic-2', label: 'Desk Mic' })
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify({ id: 'mic-2', label: 'Desk Mic' }))
  })

  it('restores a remembered selection', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ id: 'mic-1', label: 'Headset' }))
    expect(createMicrophoneDeviceStore().getSnapshot()).toEqual({ id: 'mic-1', label: 'Headset' })
  })

  it('falls back to the system default over corrupted storage', () => {
    for (const corrupt of ['[]', '"mic-1"', '{"id":7,"label":"x"}', '{"id":"mic-1"}', 'not json']) {
      window.localStorage.setItem(KEY, corrupt)
      expect(createMicrophoneDeviceStore().getSnapshot(), corrupt).toEqual({ id: '', label: '' })
    }
  })
})
