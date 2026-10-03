/**
 * The composer microphone control: one small always-visible button in the
 * `conversation.input.left` seat. Click starts a recording and a second
 * click stops and transcribes it through `speech.transcribe`; the configured
 * push-to-talk key holds-to-talk. Readiness and language come from the
 * speech settings namespace; refusals render localized guidance instead of
 * failing silently.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Recording } from './audio.ts'
import { RecordingError } from './audio.ts'
import { bytesToBase64, wavAmplitudeStats } from './wav.ts'
import { NS, type VoiceKey } from './locales.ts'
import css from './VoiceMicControl.module.css'

/** Peak below this reads as digital silence in the captured WAV (≈ −46 dBFS). */
const SILENT_PEAK = 0.005
/** Live level bars kept on screen while recording (one per 100 ms tick). */
const LEVEL_BARS = 32
/** Polling cadence of the live level meter, in milliseconds. */
const LEVEL_TICK_MS = 100

/** Speech wire face plus creation and draft-insertion verbs, injected by apply. */
export interface VoiceMicInjected {
  /** The speech RPC face of the shared connection client. */
  api: {
    speech: {
      transcribe(payload: { wavBase64: string; language?: string }, signal?: AbortSignal): Promise<{
        rpcId: unknown
        result: { ok: true; value: { text: string } } | { ok: false; error: { code: string; message: string } }
      }>
    }
  }
  /** @returns one microphone operation owned by this control's lifetime. */
  createRecording: () => Recording
  /**
   * Insert text at the draft's end through the scoped input event.
   * @returns true when the machine applied the insertion.
   */
  insertText: (sessionId: SessionId, text: string, span: TokenSpan) => boolean
  /** Bare observables the renderer binds into `use<Name>` selector hooks. */
  hooks: {
    preferences: {
      getSnapshot(): VoicePreferences
      subscribe(listener: () => void): () => void
    }
  }
}

/** Voice preferences mirrored from the speech settings namespace. */
export interface VoicePreferences {
  readonly recognizer: string
  readonly language?: string
  readonly pushToTalkKey?: string
}

/** Normalized push-to-talk key comparison (e.g. `'Shift'` → `'shift'`). */
function pushToTalkMatches(configured: string, event: KeyboardEvent): boolean {
  const key = configured.toLowerCase()
  const pressed = event.key.toLowerCase()
  if (key === pressed) return true
  if (key === 'ctrl') return pressed === 'control'
  if (key === 'control') return pressed === 'ctrl'
  return false
}

/** Component props: the owner share members this control reads, locale, and the inject face. */
export type VoiceMicControlProps =
  Pick<PropsRuntime<'conversation.input.left'>, 'input' | 'sessionId'>
  & PropsLocale<typeof NS>
  & InjectFace<VoiceMicInjected>

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing'

/** Render the microphone button with its recording and guidance states. */
export function VoiceMicControl({
  input, sessionId, t, api, createRecording, insertText, usePreferences,
}: VoiceMicControlProps) {
  const preferences = usePreferences(value => value)
  const enabled = preferences.recognizer !== 'off'
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [levels, setLevels] = useState<number[]>([])
  const recordingRef = useRef<Recording | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  // Generation guard: cancel and unmount invalidate an in-flight stop chain,
  // so a late settlement writes no state after the control returned to idle.
  const generation = useRef(0)
  const inputRef = useRef(input)
  inputRef.current = input

  const cancel = useCallback((): void => {
    generation.current += 1
    abortRef.current?.abort()
    abortRef.current = undefined
    recordingRef.current?.dispose()
    recordingRef.current = undefined
    setPending(null)
    setNotice(null)
    setPhase('idle')
  }, [])

  useEffect(() => cancel, [cancel, sessionId])

  // Live input meter: while recording, sample the capture's peak level so the
  // user can see the microphone is actually picking sound up.
  useEffect(() => {
    if (phase !== 'recording') return
    setLevels([])
    const timer = window.setInterval(() => {
      /* v8 ignore next 2 -- the interval tears down with this phase effect; the guard only keeps a late tick total. */
      const capture = recordingRef.current
      if (capture === undefined) return
      setLevels(previous => [...previous.slice(1 - LEVEL_BARS), capture.level()])
    }, LEVEL_TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [phase])

  const guidance = useCallback((key: VoiceKey): void => {
    setPending(null)
    setNotice(t(key))
  }, [t])

  const failureText = useCallback((error: unknown): string => error instanceof RecordingError
    ? t(error.kind === 'denied' ? 'mic.denied' : error.kind === 'unsupported' ? 'mic.unsupported' : 'mic.failed')
    : `${t('mic.failed')}${error instanceof Error ? error.message : String(error)}`, [t])

  /** Stop the capture, transcribe it, and insert the transcript at the draft's end. */
  const finish = useCallback(async (): Promise<void> => {
    const capture = recordingRef.current
    if (capture === undefined) return
    recordingRef.current = undefined
    const run = ++generation.current
    const abort = new AbortController()
    abortRef.current = abort
    setPhase('transcribing')
    try {
      const wav = await capture.stop()
      if (run !== generation.current) return
      const response = await api.speech.transcribe({
        wavBase64: bytesToBase64(wav),
        ...(preferences.language === undefined || preferences.language === '' ? {} : { language: preferences.language }),
      }, abort.signal)
      if (run !== generation.current) return
      if (!response.result.ok) {
        setNotice(`${t('mic.failed')}${response.result.error.message}`)
        return
      }
      if (response.result.value.text === '') {
        const stats = wavAmplitudeStats(wav)
        if (stats.peak < SILENT_PEAK) {
          setPending(null)
          setNotice(`${t('mic.silence')}（${Math.round(stats.durationMs)} ms, peak ${stats.peak.toFixed(3)}）`)
          return
        }
        guidance('mic.empty')
        return
      }

      const current = inputRef.current
      const span: TokenSpan = { start: current.draft.length, end: current.draft.length, draftRev: current.draftRev }
      if (!insertText(sessionId, response.result.value.text, span)) {
        setPending(response.result.value.text)
        setNotice(t('mic.insertFailed'))
        return
      }
      setPending(null)
      setNotice(null)
    } catch (error: unknown) {
      capture.dispose()
      if (run === generation.current) setNotice(failureText(error))
    } finally {
      if (abortRef.current === abort) abortRef.current = undefined
      setPhase('idle')
    }
  }, [api, failureText, guidance, insertText, preferences.language, sessionId, t])

  /** Acquire the microphone and begin recording. */
  const start = useCallback(async (): Promise<void> => {
    if (!enabled || recordingRef.current !== undefined || phase === 'transcribing') return
    const run = ++generation.current
    setNotice(null)
    setPending(null)
    setPhase('requesting')
    const capture = createRecording()
    recordingRef.current = capture
    try {
      await capture.start()
      if (run !== generation.current || recordingRef.current !== capture) return
      setPhase('recording')
    } catch (error: unknown) {
      if (recordingRef.current === capture) recordingRef.current = undefined
      capture.dispose()
      if (run === generation.current) {
        setNotice(failureText(error))
        setPhase('idle')
      }
    }
  }, [createRecording, enabled, failureText, phase])

  // Push-to-talk: keydown starts, keyup stops and transcribes. The listener
  // lives only while a key is configured and voice input is enabled.
  const pushToTalkKey = preferences.pushToTalkKey
  useEffect(() => {
    if (pushToTalkKey === undefined || pushToTalkKey === '' || !enabled) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.repeat || !pushToTalkMatches(pushToTalkKey, event)) return
      void start()
    }
    const onKeyUp = (event: globalThis.KeyboardEvent): void => {
      if (!pushToTalkMatches(pushToTalkKey, event)) return
      void finish()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [enabled, finish, pushToTalkKey, start])

  const onClick = (): void => {
    if (phase === 'recording') void finish()
    else if (phase === 'idle' && !enabled) guidance('mic.off')
    else void start()
  }

  const label = phase === 'recording'
    ? t('mic.stop')
    : phase === 'transcribing'
      ? t('mic.transcribing')
      : phase === 'requesting'
        ? t('mic.requesting')
        : t('mic.start')
  const busy = phase === 'requesting' || phase === 'transcribing'

  return (
    <span className={css.root} data-voice-phase={phase}>
      <button
        type="button"
        className={css.mic}
        aria-label={label}
        aria-pressed={phase === 'recording'}
        disabled={busy}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={onClick}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Zm-4.5 6.5a.75.75 0 0 1 1.5 0 3 3 0 0 0 6 0 .75.75 0 0 1 1.5 0 4.5 4.5 0 0 1-3.75 4.437V13.5h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5H7.25v-.563A4.5 4.5 0 0 1 3.5 8.5Z"
            fill="currentColor"
          />
        </svg>
      </button>
      {phase === 'recording' && (
        <span className={css.wave} aria-hidden="true">
          {levels.map((level, index) => (
            <span key={index} className={css.waveBar} style={{ height: `${Math.round(2 + level * 18)}px` }} />
          ))}
        </span>
      )}
      {(phase === 'recording' || phase === 'transcribing' || phase === 'requesting') && (
        <span className={css.state} role="status">
          {phase === 'recording' ? t('mic.recording') : phase === 'transcribing' ? t('mic.transcribing') : t('mic.requesting')}
        </span>
      )}
      {notice !== null && (
        <span className={css.notice} role="status" title={pending ?? undefined}>
          {notice}
          {pending !== null && (
            <button
              type="button"
              className={css.retry}
              onClick={() => {
                const current = inputRef.current
                const span: TokenSpan = { start: current.draft.length, end: current.draft.length, draftRev: current.draftRev }
                if (insertText(sessionId, pending, span)) cancel()
              }}
            >
              {pending}
            </button>
          )}
        </span>
      )}
      {phase === 'recording' && (
        <button type="button" className={css.cancel} aria-label={t('mic.cancel')} onClick={cancel}>
          ×
        </button>
      )}
    </span>
  )
}
