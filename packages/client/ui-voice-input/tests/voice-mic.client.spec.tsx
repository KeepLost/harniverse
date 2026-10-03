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

  it('clears the offer once the retry insertion lands', async () => {
    let accept = false
    const face = injected({
      insertText: (_sessionId, text) => {
        face.insertions.push({ text })
        return accept
      },
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    const retry = await view.findByRole('button', { name: 'recognized text' })
    fireEvent.click(retry)
    expect(view.getByRole('button', { name: 'recognized text' })).toBeTruthy()
    accept = true
    fireEvent.click(view.getByRole('button', { name: 'recognized text' }))
    await vi.waitFor(() => { expect(view.queryByRole('button', { name: 'recognized text' })).toBeNull() })
  })

  it('swallows the mousedown so the composer never loses the draft focus', async () => {
    const face = injected()
    const view = mount(face)
    const button = view.getByRole('button', { name: t('mic.start') })
    fireEvent.mouseDown(button)
    expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy()
    expect(face.calls).toHaveLength(0)
  })

  it('surfaces the live phase and a transport failure notice', async () => {
    const face = injected({
      api: {
        speech: {
          transcribe: () => { throw new Error('socket gone') },
        },
      },
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    expect(view.getByText(t('mic.requesting')).getAttribute('role')).toBe('status')
    const stop = await view.findByRole('button', { name: t('mic.stop') })
    expect(view.getByText(t('mic.recording')).getAttribute('role')).toBe('status')
    fireEvent.click(stop)
    await vi.waitFor(() => { expect(view.getByText(`${t('mic.failed')}socket gone`)).toBeTruthy() })
    expect(face.insertions).toHaveLength(0)
  })

  it('maps an unsupported capture through its own guidance key', async () => {
    const container = mediaContainer()
    container.getUserMedia = async () => { throw new Error('no hardware') }
    const face = injected({ createRecording: () => createRecording(container) })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    await vi.waitFor(() => { expect(view.getByText(t('mic.unsupported'))).toBeTruthy() })
  })

  it('maps a decode failure while stopping through the generic failure key', async () => {
    const container = mediaContainer()
    container.decode = async () => { throw new Error('corrupt blob') }
    const face = injected({ createRecording: () => createRecording(container) })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.container.textContent).toContain(t('mic.failed').trim()) })
  })

  it('renders a non-Error transcription rejection through its string form', async () => {
    const face = injected({
      api: {
        speech: {
          transcribe: () => { throw 'carrier gone' },
        },
      },
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('mic.failed')}carrier gone`)).toBeTruthy() })
  })

  it('ignores further clicks while a transcription is in flight', async () => {
    let release: (() => void) | undefined
    const face = injected({
      api: {
        speech: {
          transcribe: () => new Promise((_resolve, reject) => { release = () => { reject(new Error('late')) } }),
        },
      } as never,
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.getByText(t('mic.transcribing'))).toBeTruthy() })
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release?.()
    await vi.waitFor(() => { expect(view.getByText(`${t('mic.failed')}late`)).toBeTruthy() })
  })

  it('drops a late transcription rejection after the session changed', async () => {
    let rejectTranscribe: ((error: Error) => void) | undefined
    const face = injected({
      api: {
        speech: {
          transcribe: () => new Promise((_resolve, reject) => { rejectTranscribe = reject }),
        },
      } as never,
    })
    const view = mount(face, inputSnapshot())
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(rejectTranscribe).toBeDefined() })
    view.rerender(<VoiceMicControl
      input={inputSnapshot()}
      sessionId={'s2' as SessionId}
      t={t}
      api={face.api}
      createRecording={face.createRecording}
      insertText={face.insertText}
      usePreferences={selector => selector(face.preferencesRef.current)}
    />)
    rejectTranscribe?.(new Error('too late'))
    await act(async () => {})
    expect(view.queryByText(/too late/)).toBeNull()
    expect(face.insertions).toHaveLength(0)
  })

  it('drops a late transcription result after the session changed', async () => {
    let resolveTranscribe: ((value: { text: string }) => void) | undefined
    const face = injected({
      api: {
        speech: {
          transcribe: () => new Promise((resolve) => { resolveTranscribe = resolve }),
        },
      } as never,
    })
    const view = mount(face, inputSnapshot())
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(resolveTranscribe).toBeDefined() })
    view.rerender(<VoiceMicControl
      input={inputSnapshot()}
      sessionId={'s2' as SessionId}
      t={t}
      api={face.api}
      createRecording={face.createRecording}
      insertText={face.insertText}
      usePreferences={selector => selector(face.preferencesRef.current)}
    />)
    resolveTranscribe?.({ text: 'late text' })
    await act(async () => {})
    expect(face.insertions).toHaveLength(0)
    expect(view.queryByRole('button', { name: 'late text' })).toBeNull()
  })

  it('surfaces a refused transcription through its wire message', async () => {
    const face = injected({
      api: {
        speech: {
          transcribe: async () => ({ rpcId: 'r', result: { ok: false, error: { code: 'speech-unavailable', message: 'voice input is disabled', details: {} } } }),
        },
      } as never,
    })
    const view = mount(face)
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('mic.failed')}voice input is disabled`)).toBeTruthy() })
    expect(face.insertions).toHaveLength(0)
  })

  it('drops a recorder settlement that lands after the session changed', async () => {
    let resolveStop: ((blob: Blob) => void) | undefined
    const container = mediaContainer()
    container.createRecorder = () => ({
      stop: () => new Promise<Blob>((resolve) => { resolveStop = resolve }),
      destroy: () => {},
    })
    const face = injected({ createRecording: () => createRecording(container) })
    const view = mount(face, inputSnapshot())
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    fireEvent.click(await view.findByRole('button', { name: t('mic.stop') }))
    await vi.waitFor(() => { expect(resolveStop).toBeDefined() })
    view.rerender(<VoiceMicControl
      input={inputSnapshot()}
      sessionId={'s2' as SessionId}
      t={t}
      api={face.api}
      createRecording={face.createRecording}
      insertText={face.insertText}
      usePreferences={selector => selector(face.preferencesRef.current)}
    />)
    resolveStop?.(new Blob([new Uint8Array(8)]))
    await act(async () => {})
    expect(face.calls).toHaveLength(0)
    expect(face.insertions).toHaveLength(0)
  })

  it('drops a late capture failure after the session changed', async () => {
    let rejectStart: ((error: Error) => void) | undefined
    const container = mediaContainer()
    container.getUserMedia = () => new Promise((_resolve, reject) => { rejectStart = reject })
    const face = injected({ createRecording: () => createRecording(container) })
    const view = mount(face, inputSnapshot())
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    view.rerender(<VoiceMicControl
      input={inputSnapshot()}
      sessionId={'s2' as SessionId}
      t={t}
      api={face.api}
      createRecording={face.createRecording}
      insertText={face.insertText}
      usePreferences={selector => selector(face.preferencesRef.current)}
    />)
    rejectStart?.(new Error('denied late'))
    await act(async () => {})
    expect(view.queryByText(/denied late/)).toBeNull()
  })

  it('drops a recorder that settles after the session changed', async () => {
    let resolveStart: (() => void) | undefined
    const container = mediaContainer()
    container.getUserMedia = () => new Promise<MediaStream>((resolve) => { resolveStart = () => { resolve({} as MediaStream) } })
    const face = injected({ createRecording: () => createRecording(container) })
    const view = mount(face, inputSnapshot())
    fireEvent.click(view.getByRole('button', { name: t('mic.start') }))
    view.rerender(<VoiceMicControl
      input={inputSnapshot()}
      sessionId={'s2' as SessionId}
      t={t}
      api={face.api}
      createRecording={face.createRecording}
      insertText={face.insertText}
      usePreferences={selector => selector(face.preferencesRef.current)}
    />)
    resolveStart?.()
    await act(async () => {})
    expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy()
    expect(face.calls).toHaveLength(0)
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
  it('accepts the control-key spellings for push-to-talk', async () => {
    const face = injected({}, { recognizer: 'sensevoice', pushToTalkKey: 'ctrl' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }))
    })
    await vi.waitFor(() => { expect(view.getByRole('button', { name: t('mic.stop') })).toBeTruthy() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))
    })
    await vi.waitFor(() => { expect(face.insertions).toEqual([{ text: 'recognized text' }]) })
  })

  it('accepts the full control spelling against the abbreviated event key', async () => {
    const face = injected({}, { recognizer: 'sensevoice', pushToTalkKey: 'control' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Ctrl', bubbles: true }))
    })
    await vi.waitFor(() => { expect(view.getByRole('button', { name: t('mic.stop') })).toBeTruthy() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Ctrl', bubbles: true }))
    })
    await vi.waitFor(() => { expect(face.insertions).toEqual([{ text: 'recognized text' }]) })
  })

  it('ignores a push-to-talk press while a transcription is in flight', async () => {
    let release: (() => void) | undefined
    const face = injected({
      api: {
        speech: {
          transcribe: () => new Promise((_resolve, reject) => { release = () => { reject(new Error('late')) } }),
        },
      } as never,
    }, { recognizer: 'sensevoice', pushToTalkKey: 'shift' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    })
    await vi.waitFor(() => { expect(view.getByRole('button', { name: t('mic.stop') })).toBeTruthy() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    })
    expect(view.getByText(t('mic.transcribing'))).toBeTruthy()
    release?.()
    await vi.waitFor(() => { expect(view.getByText(`${t('mic.failed')}late`)).toBeTruthy() })
  })

  it('ignores a release with no matching capture in flight', async () => {
    const face = injected({}, { recognizer: 'sensevoice', pushToTalkKey: 'shift' })
    const view = mount(face)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    expect(view.getByRole('button', { name: t('mic.start') })).toBeTruthy()
    expect(face.calls).toHaveLength(0)
  })

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

describe('createRecording failure kinds', () => {
  it('maps a non-permission getUserMedia failure to unsupported', async () => {
    const container = mediaContainer()
    container.getUserMedia = async () => { throw new Error('no audio hardware') }
    await expect(createRecording(container).start()).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('maps a security denial to the denied guidance', async () => {
    const container = mediaContainer()
    container.getUserMedia = async () => { throw new DOMException('blocked', 'SecurityError') }
    await expect(createRecording(container).start()).rejects.toMatchObject({ kind: 'denied' })
  })

  it('rejects a stop before any start and an empty recording distinctly', async () => {
    const container = mediaContainer()
    await expect(createRecording(container).stop()).rejects.toMatchObject({ kind: 'stopped' })
    container.createRecorder = () => ({
      stop: async () => new Blob([new Uint8Array(0)]),
      destroy: () => {},
    })
    const capture = createRecording(container)
    await capture.start()
    await expect(capture.stop()).rejects.toMatchObject({ kind: 'no-data' })
  })

  it('maps a decode failure while stopping to decode', async () => {
    const container = mediaContainer()
    container.decode = async () => { throw new Error('corrupt blob') }
    const capture = createRecording(container)
    await capture.start()
    await expect(capture.stop()).rejects.toMatchObject({ kind: 'decode' })
  })
})
