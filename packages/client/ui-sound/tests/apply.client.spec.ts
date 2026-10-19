/**
 * Registration and lifecycle: one apply registers the dictionaries, the
 * `sound` settings section (id, order, live label), and its nav glyph, and
 * every registration leaves with the plugin fiber (the HMR-safety rule).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { SoundSection } from '../src/client/SoundSection.tsx'
import { NavIcon } from '../src/client/NavIcon.tsx'
import { zh } from '../src/client/locales.ts'
import { defaultSoundSettings } from '../src/sound-settings.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

/** Build one client bench with the plugin's service doubles. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({
        ids: [], byId: {}, current: undefined, phase: 'ready' as const,
        subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0,
      }),
    },
  })
  ctx.provide('connection', {})
  const set = vi.fn(() => Promise.resolve())
  const scope = {
    getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }),
    subscribe: (_listener: () => void) => () => {},
    set,
  }
  ctx.provide('settingsScope', { bind: () => scope })
  return { ctx, slots: ctx.slots, scope }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.nav.icon': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-sound apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'connection', 'settingsScope'])
  })

  it('cancels the watcher open burst when disposed immediately', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = await ctx.plugin({ apply, inject }).await()
    await fiber.dispose()
  })

  it('registers the section at id sound with order 75, the shipped label, and the nav glyph', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'sound')
    expect(section?.component).toBe(SoundSection)
    expect(section?.options).toMatchObject({ id: 'sound', order: 75 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    expect(slots.entries('settings.nav.icon').map(entry => [entry.options.key, entry.component]))
      .toEqual([['sound', NavIcon]])
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ apply, inject }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
    await vi.waitFor(() => { expect(slots.entries('settings.nav.icon')).toHaveLength(1) })
  })

  it('disposes the section, nav glyph, and watcher with the plugin fiber', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = await ctx.plugin({ apply, inject }).await()

    expect(slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('settings.nav.icon')).toHaveLength(0)
  })

  it('opens watcher streams through the captured api and survives a throwing open', async () => {
    const opens: string[] = []
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
    const api = {
      events: {
        mux: (_request: object, _signal: AbortSignal): AsyncIterable<never> => {
          opens.push('mux')
          throw new Error('transport down')
        },
        host: (_request: object, _signal: AbortSignal): AsyncIterable<never> => {
          opens.push('host')
          return (async function* hostStream(): AsyncIterable<never> {
            /* one ended stream: the opener failed this attempt */
          })()
        },
      },
    }
    ctx.provide('connection', { captureApi: () => api })
    ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
    declareRoot(ctx.slots)
    const fiber = await ctx.plugin({ apply, inject }).await()
    await vi.waitFor(() => { expect(opens).toContain('mux') })
    await fiber.dispose()
  })

  it('degrades when the connection service has no captureApi and when capture throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
    ctx.provide('connection', { captureApi: () => { throw new Error('switching') } })
    ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
    declareRoot(ctx.slots)
    const fiber = await ctx.plugin({ apply, inject }).await()
    await vi.waitFor(() => { expect(ctx.slots.entries('settings.section')).toHaveLength(1) })
    await fiber.dispose()
  })

  it('builds the engine without Web Audio and without a broadcast channel when absent', async () => {
    const carrier = globalThis as { AudioContext?: unknown; BroadcastChannel?: unknown }
    const restoreAudio = carrier.AudioContext
    const restoreChannel = carrier.BroadcastChannel
    carrier.AudioContext = undefined
    carrier.BroadcastChannel = undefined
    try {
      const { ctx, slots } = await bench()
      declareRoot(slots)
      const fiber = await ctx.plugin({ apply, inject }).await()
      expect(slots.entries('settings.section')).toHaveLength(1)
      await fiber.dispose()
    } finally {
      carrier.AudioContext = restoreAudio
      carrier.BroadcastChannel = restoreChannel
    }
  })

  it('survives a broadcast channel constructor that throws', async () => {
    const carrier = globalThis as { BroadcastChannel?: unknown }
    const restore = carrier.BroadcastChannel
    const throwingChannel = (): unknown => { throw new Error('blocked') }
    carrier.BroadcastChannel = throwingChannel
    try {
      const { ctx, slots } = await bench()
      declareRoot(slots)
      const fiber = await ctx.plugin({ apply, inject }).await()
      expect(slots.entries('settings.section')).toHaveLength(1)
      await fiber.dispose()
    } finally {
      carrier.BroadcastChannel = restore
    }
  })

  it('delivers a completed turn through the supplementary stream into the engine', async () => {
    const frames: Array<() => void> = []
    const turnEnd = () => ({
      rpcId: 1,
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
    })
    const api = {
      events: {
        mux: (_request: object, _signal: AbortSignal): AsyncIterable<{ rpcId: number; payload: unknown }> => (async function* muxStream() {
          while (true) {
            await new Promise<void>((resolve) => { frames.push(resolve) })
            yield turnEnd()
          }
        })(),
        host: (_request: object, _signal: AbortSignal): AsyncIterable<never> => (async function* hostStream(): AsyncIterable<never> {
          /* one ended stream: the loop enters its reopen wait, cancelled at dispose */
        })(),
      },
    }
    const scopeState: { status: 'ready' | 'loading'; value: ReturnType<typeof defaultSoundSettings> | undefined } = {
      status: 'ready',
      value: defaultSoundSettings(),
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
    ctx.provide('connection', { captureApi: () => api })
    const carrier = globalThis as { AudioContext?: unknown; BroadcastChannel?: unknown }
    const restoreAudio = carrier.AudioContext
    const restoreChannel = carrier.BroadcastChannel
    carrier.BroadcastChannel = class {
      postMessage(): void { /* isolated tab */ }
      close(): void { /* nothing to release */ }
      onmessage = null
    }
    const played: string[] = []
    carrier.AudioContext = class {
      state = 'running'
      currentTime = 0
      destination = {}
      resume() { return Promise.resolve() }
      createOscillator() {
        const oscillator = { type: 'sine', frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {}, start: () => { played.push('osc') }, stop: () => {} }
        return oscillator
      }
      createGain() { return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, value: 1 }, connect: () => {} } }
      decodeAudioData() { return Promise.resolve({}) }
      createBufferSource() { return { buffer: undefined, connect: () => {}, start: () => {} } }
    }
    ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ ...scopeState, writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
    declareRoot(ctx.slots)
    let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined
    try {
      fiber = await ctx.plugin({ apply, inject }).await()
      scopeState.status = 'loading'
      for (const release of frames.splice(0)) release()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(played).toHaveLength(0)
      scopeState.status = 'ready'
      scopeState.value = undefined
      for (const release of frames.splice(0)) release()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(played).toHaveLength(0)
      scopeState.value = { ...defaultSoundSettings(), enabled: false }
      for (const release of frames.splice(0)) release()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(played).toHaveLength(0)
      scopeState.value = defaultSoundSettings()
      for (const release of frames.splice(0)) release()
      await vi.waitFor(() => { expect(played.length).toBeGreaterThan(0) })
    } finally {
      carrier.AudioContext = restoreAudio
      carrier.BroadcastChannel = restoreChannel
      await fiber?.dispose()
    }
  })

  it('passes the bound scope through to the section inject face', async () => {
    const { ctx, slots, scope } = await bench()
    declareRoot(slots)
    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'sound')
    const face = section?.inject?.() as {
      hooks: { settings: typeof scope }
      setField: (field: string, value: unknown) => Promise<void>
      chooseFile: () => Promise<string | undefined>
      audioName: (value: string) => Promise<string>
      preview: (value: string, volume: number) => void
    }
    expect(face.hooks.settings).toBe(scope)
    expect(face.hooks.settings.getSnapshot().value).toEqual(defaultSoundSettings())
    await face.setField('enabled', false)
    expect(scope.set).toHaveBeenCalledWith('enabled', false)
    await expect(face.audioName('ding')).resolves.toBe('')
    await expect(face.audioName('audio:gone')).resolves.toBe('')

    const listeners = new Map<string, () => void>()
    const input = {
      type: '',
      accept: '',
      style: { display: '' },
      files: [] as unknown[],
      addEventListener: (name: string, handler: () => void) => { listeners.set(name, handler) },
      remove: () => { /* detached */ },
      click: () => { listeners.get('cancel')?.() },
    }
    const carrier = globalThis as { document?: unknown }
    const restoreDocument = carrier.document
    carrier.document = { createElement: () => input, body: { appendChild: () => { /* attached */ } } }
    try {
      await expect(face.chooseFile()).resolves.toBeUndefined()
      input.files = [new Blob(['x'])]
      input.click = () => { listeners.get('change')?.() }
      await expect(face.chooseFile()).resolves.toBe('local')
    } finally {
      carrier.document = restoreDocument
    }
    face.preview('ding', 1)
  })
})
