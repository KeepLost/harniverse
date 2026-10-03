// @vitest-environment jsdom
/**
 * The browser half's own bindings end to end: the settings decode narrowing,
 * the preferences mirror's live derivation, and the real media container
 * (getUserMedia, MediaRecorder lifecycle, AudioContext decode) reached
 * through the ledger inject face the way the outlet would.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { VoiceMicInjected } from '../src/client/VoiceMicControl.tsx'
import type { VoiceSection } from '../src/client/VoiceSettingsSection.tsx'

type ScopeSnapshot = { status: 'ready'; value: VoiceSection | undefined; user: unknown; writable: boolean }

interface CapturedScope {
  snapshot: ScopeSnapshot
  listeners: (() => void)[]
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
}

async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; scope: CapturedScope; decode: (section: unknown) => unknown }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('sessions', { scope: () => undefined })
  ctx.provide('connection', { api: {} } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  const scope: CapturedScope = {
    snapshot: { status: 'ready', value: undefined, user: undefined, writable: true },
    listeners: [],
    getSnapshot: () => scope.snapshot,
    subscribe: (listener: () => void) => {
      scope.listeners.push(listener)
      return () => {}
    },
  }
  let decode: (section: unknown) => unknown = () => undefined
  ctx.provide('settingsScope', {
    bind: (binding: { namespace: string; decode(section: unknown): unknown }) => {
      decode = (section: unknown) => binding.decode(section)
      return scope as never
    },
  } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, scope, decode }
}

function micFace(ctx: Context): VoiceMicInjected {
  const entry = ctx.slots.entries('conversation.input.left').find(candidate => candidate.options.id === 'voice-input')
  return (entry as unknown as { inject: () => VoiceMicInjected }).inject()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ui-voice-input browser bindings', () => {
  it('narrows one wire section: objects pass, everything else keeps the last value', async () => {
    const { ctx, fiber, decode } = await bench()
    try {
      expect(decode({ recognizer: 'sensevoice' })).toEqual({ recognizer: 'sensevoice' })
      expect(decode(null)).toBeUndefined()
      expect(decode(['sensevoice'])).toBeUndefined()
      expect(decode('sensevoice')).toBeUndefined()
      expect(micFace(ctx)).toBeDefined()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('derives the mirrored preferences live from the settings scope', async () => {
    const { ctx, fiber, scope } = await bench()
    try {
      const face = micFace(ctx)
      expect(face.hooks.preferences.getSnapshot()).toEqual({ recognizer: 'off' })
      scope.snapshot.value = { recognizer: 'sensevoice', language: 'zh', pushToTalkKey: 'shift' }
      for (const listener of scope.listeners) listener()
      expect(face.hooks.preferences.getSnapshot()).toEqual({ recognizer: 'sensevoice', language: 'zh', pushToTalkKey: 'shift' })
      scope.snapshot.value = { recognizer: 'sensevoice', language: '', pushToTalkKey: '' }
      for (const listener of scope.listeners) listener()
      expect(face.hooks.preferences.getSnapshot()).toEqual({ recognizer: 'sensevoice' })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('captures and decodes through the real media container', async () => {
    const track = { stop: vi.fn() }
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: { size: number } }) => void) | null = null
      onstop: (() => void) | null = null
      private active = true
      start(): void { this.active = true }
      stop(): void {
        if (!this.active) throw new Error('recorder already stopped')
        this.active = false
        this.onstop?.()
      }
      emit(size: number): void { this.ondataavailable?.({ data: { size } }) }
    }
    let recorder: FakeRecorder | undefined
    vi.stubGlobal('MediaRecorder', class extends FakeRecorder {
      constructor() {
        super()
        // oxlint-disable-next-line no-this-alias -- the stub intentionally captures its instance for the emit probes
        recorder = this
      }
    })
    vi.stubGlobal('AudioContext', class {
      decodeAudioData = async (): Promise<AudioBuffer> => ({
        duration: 0.001,
        length: 8,
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array(8).fill(0.1),
      } as AudioBuffer)
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    })
    const { ctx, fiber } = await bench()
    try {
      const face = micFace(ctx)

      // An abandoned capture releases its tracks through destroy's live path.
      const abandoned = face.createRecording()
      await abandoned.start()
      abandoned.dispose()
      expect(track.stop).toHaveBeenCalled()

      // Non-empty chunks survive the funnel; empty ones drop out.
      const capture = face.createRecording()
      await capture.start()
      recorder?.emit(8)
      recorder?.emit(0)
      const wav = await capture.stop()
      expect(wav).toBeInstanceOf(Uint8Array)
      // Stopping already released the tracks; a second destroy stays inert.
      capture.dispose()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})
