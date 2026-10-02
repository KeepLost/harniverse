/**
 * Voice input plugin, browser half: contributes the composer microphone
 * control (the `conversation.input.left` seat, click and push-to-talk over
 * `speech.transcribe`) and the Settings → Voice input section
 * (`settings.section`, preference writes through the shared speech settings
 * scope plus the `speech.prepare` verb). Preferences mirror the host-side
 * `speech` namespace; transcripts insert through the scoped input event, so
 * this plugin owns no draft state of its own.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat) and
// the ui-settings SlotMap merge (the settings.section entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createRecording } from './audio.ts'
import { VoiceMicControl } from './VoiceMicControl.tsx'
import type { VoiceMicInjected, VoicePreferences } from './VoiceMicControl.tsx'
import { VoiceSettingsSection } from './VoiceSettingsSection.tsx'
import type { VoiceSection, VoiceSettingsInjected } from './VoiceSettingsSection.tsx'
import { en, NS, zh, type VoiceKey } from './locales.ts'

export type { VoicePreferences } from './VoiceMicControl.tsx'
export type { VoiceSection } from './VoiceSettingsSection.tsx'
export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Voice input copy (microphone control and settings section). */
    voice: VoiceKey
  }
}

/** Narrow one wire section of the speech namespace; undefined keeps the last accepted value. */
function decodeVoiceSection(section: unknown): VoiceSection | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  return section
}

/**
 * The bare observable the microphone control's hooks compartment reads:
 * a store derived from the speech settings scope (registers its own
 * subscription; the input.left inject face receives it per session).
 */
class VoicePreferencesMirror {
  readonly store: SnapshotStore<VoicePreferences> = createSnapshotStore({ recognizer: 'off' })

  constructor(scope: SettingsScope<VoiceSection>) {
    scope.subscribe(() => { this.derive(scope) })
    this.derive(scope)
  }

  private derive(scope: SettingsScope<VoiceSection>): void {
    const value = scope.getSnapshot().value
    this.store.set({
      recognizer: value?.recognizer ?? 'off',
      ...value?.language === undefined || value.language === '' ? {} : { language: value.language },
      ...value?.pushToTalkKey === undefined || value.pushToTalkKey === '' ? {} : { pushToTalkKey: value.pushToTalkKey },
    })
  }
}

/** Browser media container binding for capture creation. */
const browserContainer = {
  getUserMedia: (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints),
  createRecorder: (stream: MediaStream) => {
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    recorder.start()
    const tracks = stream.getTracks()
    return {
      stop: () => new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          for (const track of tracks) track.stop()
          resolve(new Blob(chunks, { type: recorder.mimeType }))
        }
        recorder.stop()
      }),
      destroy: () => {
        try { recorder.stop() } catch (_inactiveRecorder) {
          // Stopping an already-stopped recorder throws; the tracks below are the release.
        }
        for (const track of tracks) track.stop()
      },
    }
  },
  decode: (data: ArrayBuffer) => new AudioContext({ sampleRate: 16_000 }).decodeAudioData(data),
}

/** Required services: the seat's slot registry, settings scope, sessions, wire face, and copy. */
export const inject = ['slots', 'locale', 'connection', 'sessions', 'settingsScope']

/**
 * Client plugin body: register the dictionaries, the composer microphone
 * entry, and the Voice input settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-input: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const scope = ctx.settingsScope.bind({ namespace: 'speech', decode: decodeVoiceSection })
  const mirror = new VoicePreferencesMirror(scope)
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-input',
    // After the plan chip: mode chrome reads before capture affordances.
    order: 30,
    locale: NS,
    inject: (): VoiceMicInjected => ({
      api: connection.api,
      createRecording: () => createRecording(browserContainer),
      insertText: (sessionId: SessionId, text: string, span: TokenSpan): boolean => {
        const actx = ctx.sessions.scope(sessionId)
        return actx !== undefined && actx.bail(actx, 'slash/input-insert-text', { text, span }) === true
      },
      hooks: { preferences: mirror.store },
    }),
  }, VoiceMicControl))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'voice',
    // After the model sections; voice is an input modality, read after models.
    order: 25,
    label: () => t('settings.nav'),
    locale: NS,
    inject: (): VoiceSettingsInjected => ({ scope, api: connection.api }),
  }, VoiceSettingsSection))
}
