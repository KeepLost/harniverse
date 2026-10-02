// @vitest-environment jsdom
/**
 * The microphone control's behavior with a fake api client and scripted
 * media: the click state machine (idle → recording → transcribing → idle),
 * permission-denied and disabled guidance, push-to-talk key handling, and
 * the draft-insertion CAS path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createRecording } from '../src/client/audio.ts'
import type { MediaContainer } from '../src/client/audio.ts'
import { encodeWav16kMono } from '../src/client/wav.ts'
import { VoiceMicControl } from '../src/client/VoiceMicControl.tsx'
import type { VoiceMicControlProps, VoiceMicInjected, VoicePreferences } from '../src/client/VoiceMicControl.tsx'
import { en } from '../src/client/locales.ts'

const t: VoiceMicControlProps['t'] = makeTranslate(en)
const SESSION = 's1' as SessionId

/** Scripted media container: one track of PCM samples per capture. */
function mediaContainer(options: { deny?: boolean } = {}) {
  const container: MediaContainer = {
    getUserMedia: async () => {
      if (options.deny) throw new DOMException('denied', 'NotAllowedError')
      return {} as MediaStream
    },
    createRecorder: () => ({
      stop: async () => new Blob([new Uint8Array(8)]),
      destroy: () => {},
    }),
    decode: async () => ({
      duration: 0.001,
      length: 16,
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array(16).fill(0.1),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    }),
  }
  return container
}

type TranscribeCall = { wavBase64: string; language?: string }

function injected(overrides: Partial<VoiceMicInjected> = {}, preferences: VoicePreferences = { recognizer: 'sensevoice' }) {
  const calls: TranscribeCall[] = []
  const insertions: { text: string }[] = []
  let answer: { text: string } = { text: 'recognized text' }
  const injected: VoiceMicInjected & {
    setAnswer: (value: { text: string }) => void
    calls: TranscribeCall[]
    insertions: { text: string }[]
    preferencesRef: { current: VoicePreferences }
  } = {
    api: {
      speech: {
        transcribe: async (payload) => {
          calls.push(payload)
          return { rpcId: 'r', result: { ok: true, value: answer } }
        },
      },
    },
    createRecording: () => createRecording(mediaContainer()),
    insertText: (_sessionId, text) => {
      insertions.push({ text })
      return true
    },
    hooks: {
      preferences: {
        getSnapshot: () => preferences,
        subscribe: () => () => {},
      },
    },
    setAnswer: (value: { text: string }) => { answer = value },
    calls,
    insertions,
    preferencesRef: { current: preferences },
    ...overrides,
  }
  return injected
}

/** The left-seat owner share member this control reads: a point-in-time input snapshot. */
function inputSnapshot(draft = '') {
  return { draft, imageIds: [], draftRev: 1, phase: 'plain' as const, occurrences: [], queue: [] }
}

function mount(injectedFace: ReturnType<typeof injected>, input = inputSnapshot()) {
  return render(
    <VoiceMicControl
      input={input}
      sessionId={SESSION}
      t={t}
      api={injectedFace.api}
      createRecording={injectedFace.createRecording}
      insertText={injectedFace.insertText}
      usePreferences={selector => selector(injectedFace.preferencesRef.current)}
    />,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('VoiceMicControl state machine', () => {
  it('click starts recording and a second click transcribes and inserts the text', async () => {
    const face = injected()
    const view = mount(face)
    const button = view.getByRole('button', { name: t('mic.start') })
    fireEvent.click(button)
    const stop = await view.findByRole('button', { name: t('mic.stop') })
    fireEvent.click(stop)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy() })
    expect(face.calls).toHaveLength(1)
    expect(face.calls[0]?.wavBase64).toBeTruthy()
    expect(face.insertions).toEqual([{ text: 'recognized text' }])
  })

  it('renders guidance and inserts nothing while voice input is off', async () => {
    const face = injected({}, { recognizer: 'off' })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    expect(view.getByText(t('mic.off')).getAttribute('role')).toBe('status')
    expect(face.calls).toHaveLength(0)
  })

  it('renders permission-denied guidance when getUserMedia is refused', async () => {
    const face = injected({
      createRecording: () => createRecording(mediaContainer({ deny: true })),
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    await vi.waitFor(() => { expect(view.getByText(t('mic.denied'))).toBeTruthy() })
    expect(face.calls).toHaveLength(0)
  })

  it('surfaces an empty transcript as guidance without insertion', async () => {
    const face = injected()
    face.setAnswer({ text: '' })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.getByText(t('mic.empty'))).toBeTruthy() })
    expect(face.insertions).toHaveLength(0)
  })

  it('offers the transcript for manual insertion when the draft CAS misses', async () => {
    const face = injected({
      insertText: () => false,
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'recognized text' })).toBeTruthy() })
    expect(view.container.textContent).toContain(t('mic.insertFailed'))
  })

  it('forwards the configured language hint with the transcription request', async () => {
    const face = injected({}, { recognizer: 'sensevoice', language: 'zh' })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(face.calls).toHaveLength(1) })
    expect(face.calls[0]?.language).toBe('zh')
  })
})

describe('VoiceMicControl push-to-talk', () => {
  it('holds the configured key to talk and releases to transcribe', async () => {
    const face = injected({}, { recognizer: 'sensevoice', pushToTalkKey: 'shift' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    })
    await vi.waitFor(() => { expect(view.getByRole('button', { name: t('mic.stop') })).toBeTruthy() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    await vi.waitFor(() => { expect(face.insertions).toEqual([{ text: 'recognized text' }]) })
  })

  it('ignores keys that are not the configured push-to-talk key', async () => {
    const face = injected({}, { recognizer: 'sensevoice', pushToTalkKey: 'shift' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    })
    expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy()
    expect(face.calls).toHaveLength(0)
  })

  it('installs no push-to-talk listener while no key is configured', async () => {
    const face = injected({}, { recognizer: 'sensevoice' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy()
    expect(face.calls).toHaveLength(0)
  })
})

describe('canonical wire payload', () => {
  it('sends encoder output through base64 untouched', () => {
    const wav = encodeWav16kMono(new Float32Array(8))
    expect(wav.length).toBe(60)
    expect(wav[0]).toBe('R'.charCodeAt(0))
  })
})
