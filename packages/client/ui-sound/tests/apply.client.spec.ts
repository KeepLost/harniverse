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

  it('tears the watcher down when disposed immediately', async () => {
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
      },
    }
    ctx.provide('connection', { captureApi: () => api })
    ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
    declareRoot(ctx.slots)
    const fiber = await ctx.plugin({ apply, inject }).await()
    await vi.waitFor(() => { expect(opens).toContain('mux') })
    await fiber.dispose()
  })

  it('defers watcher streams until the shared connection reports ready', async () => {
    vi.useFakeTimers()
    try {
      const opens: string[] = []
      const listeners = new Set<() => void>()
      let state: 'connecting' | 'connected' = 'connecting'
      const api = {
        events: {
          mux: (_request: object, _signal: AbortSignal): AsyncIterable<never> => {
            opens.push('mux')
            return (async function* muxStream(): AsyncIterable<never> {
              /* ends immediately: the loop enters its reopen wait */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      await vi.advanceTimersByTimeAsync(10_000)
      expect(opens).toEqual([])

      state = 'connected'
      for (const listener of [...listeners]) listener()
      await vi.advanceTimersByTimeAsync(1_499)
      expect(opens).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(opens).toContain('mux')

      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stands the watcher down when readiness drops and rearms a fresh generation later', async () => {
    vi.useFakeTimers()
    try {
      let state: 'bypass' | 'reconnecting' | 'connected' = 'bypass'
      const listeners = new Set<() => void>()
      const signals: AbortSignal[] = []
      let aborted = 0
      const opens: string[] = []
      const api = {
        events: {
          mux: (_request: object, signal: AbortSignal): AsyncIterable<never> => {
            opens.push('mux')
            signals.push(signal)
            signal.addEventListener('abort', () => { aborted += 1 })
            return (async function* muxStream(): AsyncIterable<never> {
              /* ends immediately */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      await vi.advanceTimersByTimeAsync(1_500)
      expect(opens).toContain('mux')
      const firstWave = opens.length

      state = 'reconnecting'
      for (const listener of [...listeners]) listener()
      expect(aborted).toBe(signals.length)
      expect(opens).toHaveLength(firstWave)

      state = 'connected'
      for (const listener of [...listeners]) listener()
      await vi.advanceTimersByTimeAsync(1_499)
      expect(opens).toHaveLength(firstWave)
      await vi.advanceTimersByTimeAsync(1)
      expect(opens.length).toBeGreaterThan(firstWave)

      await fiber.dispose()
      expect(aborted).toBe(signals.length)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts once when the connection is ready at mount and weathers later health flips', async () => {
    vi.useFakeTimers()
    try {
      let state: 'bypass' | 'reconnecting' | 'connected' = 'bypass'
      const listeners = new Set<() => void>()
      const opens: string[] = []
      const api = {
        events: {
          mux: (_request: object, _signal: AbortSignal): AsyncIterable<never> => {
            opens.push('mux')
            return (async function* muxStream(): AsyncIterable<never> {
              /* ends immediately */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      state = 'connected'
      for (const listener of [...listeners]) listener()
      state = 'reconnecting'
      for (const listener of [...listeners]) listener()
      state = 'connected'
      for (const listener of [...listeners]) listener()

      await vi.advanceTimersByTimeAsync(1_500)
      expect(opens).toContain('mux')

      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never opens watcher streams when the plugin is disposed before the connection turns ready', async () => {
    vi.useFakeTimers()
    try {
      const opens: string[] = []
      const listeners = new Set<() => void>()
      let state: 'connecting' | 'connected' = 'connecting'
      const api = {
        events: {
          mux: (_request: object, _signal: AbortSignal): AsyncIterable<never> => {
            opens.push('mux')
            return (async function* muxStream(): AsyncIterable<never> {
              /* ends immediately */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()
      await fiber.dispose()

      state = 'connected'
      for (const listener of [...listeners]) listener()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(opens).toEqual([])
    } finally {
      vi.useRealTimers()
    }
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

  it('builds the engine without Web Audio when absent', async () => {
    const carrier = globalThis as { AudioContext?: unknown }
    const restoreAudio = carrier.AudioContext
    carrier.AudioContext = undefined
    try {
      const { ctx, slots } = await bench()
      declareRoot(slots)
      const fiber = await ctx.plugin({ apply, inject }).await()
      expect(slots.entries('settings.section')).toHaveLength(1)
      await fiber.dispose()
    } finally {
      carrier.AudioContext = restoreAudio
    }
  })

  it('delivers a routed completion occurrence through the supplementary stream into the engine', async () => {
    const frames: Array<() => void> = []
    const completionNotify = (sessionId: string, rpcId: number) => ({
      rpcId,
      payload: { type: 'session/notify', sessionId, kind: 'completion', sourceKey: `turn:${sessionId}:1` },
    })
    let nextEvent = completionNotify('s1', 1)
    const api = {
      events: {
        mux: (_request: object, _signal: AbortSignal): AsyncIterable<{ rpcId: number; payload: unknown }> => (async function* muxStream() {
          while (true) {
            await new Promise<void>((resolve) => { frames.push(resolve) })
            yield nextEvent
          }
        })(),
      },
    }
    const scopeState: { status: 'ready' | 'loading'; value: ReturnType<typeof defaultSoundSettings> | undefined } = {
      status: 'ready',
      value: defaultSoundSettings(),
    }
    const open = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', {
      open,
      list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { displayTitle: 'Session One' } }, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) },
    })
    ctx.provide('connection', { captureApi: () => api })
    const carrier = globalThis as { AudioContext?: unknown; Notification?: unknown }
    const restoreAudio = carrier.AudioContext
    const played: string[] = []
    const toasts: Array<{ title: string; options: { body: string }; activate: () => void }> = []
    const focusWindow = vi.fn()
    carrier.Notification = class {
      static permission = 'granted' as const
      static requestPermission(): Promise<string> { return Promise.resolve('granted') }
      onclick: (() => void) | null = null
      constructor(public title: string, public options: { body: string }) {
        toasts.push({ title, options, activate: () => { this.onclick?.() } })
      }
      close(): void { /* released */ }
    }
    const carrierDocument = carrier as { document?: unknown }
    const carrierWindow = carrier as { window?: unknown }
    const restoreDocument = carrierDocument.document
    const restoreWindow = carrierWindow.window
    carrierDocument.document = { visibilityState: 'hidden', hasFocus: () => false }
    carrierWindow.window = { focus: focusWindow }
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
      await vi.waitFor(() => { expect(toasts.length).toBeGreaterThan(0) })
      expect(toasts[0]!.title).toBe('任务完成')
      expect(toasts[0]!.options.body).toBe('Session One')
      toasts[0]!.activate()
      expect(focusWindow).toHaveBeenCalledOnce()
      expect(open).toHaveBeenCalledWith('s1')
      nextEvent = completionNotify('s2', 2)
      for (const release of frames.splice(0)) release()
      await vi.waitFor(() => { expect(toasts.length).toBeGreaterThan(1) })
      expect(toasts[1]!.title).toBe('任务完成')
      expect(toasts[1]!.options.body).toBe('')
      toasts[1]!.activate()
      expect(focusWindow).toHaveBeenCalledTimes(2)
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      carrier.AudioContext = restoreAudio
      carrier.Notification = undefined
      carrierDocument.document = restoreDocument
      carrierWindow.window = restoreWindow
      await fiber?.dispose()
    }
  })

  it('prompts for permission once and keeps toasting later alerts without re-prompting', async () => {
    const frames: Array<() => void> = []
    let nextEvent: { rpcId: number; payload: unknown } = {
      rpcId: 1,
      payload: { type: 'session/notify', sessionId: 's1', kind: 'completion', sourceKey: 'turn:s1:1' },
    }
    const api = {
      events: {
        mux: (_request: object, _signal: AbortSignal): AsyncIterable<{ rpcId: number; payload: unknown }> => (async function* muxStream() {
          while (true) {
            await new Promise<void>((resolve) => { frames.push(resolve) })
            yield nextEvent
          }
        })(),
      },
    }
    const open = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', {
      open,
      list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { displayTitle: 'Session One' } }, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) },
    })
    ctx.provide('connection', { captureApi: () => api })
    ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
    const carrier = globalThis as {
      AudioContext?: unknown
      Notification?: unknown
      document?: unknown
      window?: unknown
    }
    const restoreAudio = carrier.AudioContext
    const restoreNotification = carrier.Notification
    const restoreDocument = carrier.document
    const restoreWindow = carrier.window
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
    const toasts: Array<{ title: string; options: { body: string }; activate: () => void }> = []
    const focusWindow = vi.fn()
    let requests = 0
    carrier.Notification = class {
      static permission = 'default'
      static requestPermission(): Promise<string> {
        requests += 1
        this.permission = 'granted'
        return Promise.resolve('granted')
      }
      onclick: (() => void) | null = null
      constructor(public title: string, public options: { body: string }) {
        toasts.push({ title, options, activate: () => { this.onclick?.() } })
      }
      close(): void { /* released */ }
    }
    carrier.document = { visibilityState: 'visible', hasFocus: () => false }
    carrier.window = { focus: focusWindow }
    declareRoot(ctx.slots)
    let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined
    try {
      fiber = await ctx.plugin({ apply, inject }).await()
      for (const release of frames.splice(0)) release()
      await vi.waitFor(() => { expect(played.length).toBeGreaterThan(0) })
      await vi.waitFor(() => { expect(toasts.length).toBeGreaterThan(0) })
      expect(requests).toBe(1)
      expect(toasts[0]!.title).toBe('任务完成')
      toasts[0]!.activate()
      expect(focusWindow).toHaveBeenCalledOnce()
      expect(open).toHaveBeenCalledWith('s1')
      nextEvent = {
        rpcId: 2,
        payload: { type: 'session/notify', sessionId: 's1', kind: 'completion', sourceKey: 'turn:s1:2' },
      }
      for (const release of frames.splice(0)) release()
      await vi.waitFor(() => { expect(toasts.length).toBeGreaterThan(1) })
      expect(requests).toBe(1)
    } finally {
      carrier.AudioContext = restoreAudio
      carrier.Notification = restoreNotification
      carrier.document = restoreDocument
      carrier.window = restoreWindow
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

  it('retires a generation the carrier keeps closing and rearms after the cooldown', async () => {
    vi.useFakeTimers()
    try {
      const state: 'bypass' | 'reconnecting' | 'connected' = 'connected'
      const listeners = new Set<() => void>()
      const signals: AbortSignal[] = []
      let aborted = 0
      let opens = 0
      const api = {
        events: {
          mux: (_request: object, signal: AbortSignal): AsyncIterable<never> => {
            opens += 1
            signals.push(signal)
            signal.addEventListener('abort', () => { aborted += 1 })
            return (async function* muxStream(): AsyncIterable<never> {
              /* the carrier closes fresh streams at once */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      await vi.advanceTimersByTimeAsync(1_500 + 800 + 800)
      expect(opens).toBeGreaterThanOrEqual(2)
      expect(aborted).toBe(signals.length)
      const opensAtTrip = opens

      await vi.advanceTimersByTimeAsync(55_000)
      expect(opens).toBe(opensAtTrip)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(opens).toBeGreaterThan(opensAtTrip)

      await fiber.dispose()
      expect(aborted).toBe(signals.length)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cooldown quiet when readiness lapsed without a notification', async () => {
    vi.useFakeTimers()
    try {
      let state: 'connected' | 'reconnecting' = 'connected'
      const listeners = new Set<() => void>()
      let opens = 0
      const api = {
        events: {
          mux: (): AsyncIterable<never> => {
            opens += 1
            return (async function* muxStream(): AsyncIterable<never> {
              /* closed at once */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', {
        captureApi: () => api,
        health: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      await vi.advanceTimersByTimeAsync(1_500 + 1_600)
      const opensAtTrip = opens
      // The health source went stale without notifying; the cooldown must not rearm against it.
      state = 'reconnecting'
      await vi.advanceTimersByTimeAsync(60_001)
      expect(opens).toBe(opensAtTrip)
      state = 'connected'
      for (const listener of [...listeners]) listener()
      await vi.advanceTimersByTimeAsync(1_499)
      expect(opens).toBe(opensAtTrip)
      await vi.advanceTimersByTimeAsync(1)
      expect(opens).toBeGreaterThan(opensAtTrip)

      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rearms the health-less generation once after the carrier cooldown', async () => {
    vi.useFakeTimers()
    try {
      let opens = 0
      const api = {
        events: {
          mux: (): AsyncIterable<never> => {
            opens += 1
            return (async function* muxStream(): AsyncIterable<never> {
              /* closed at once */
            })()
          },
        },
      }
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready' as const, subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0 }) } })
      ctx.provide('connection', { captureApi: () => api })
      ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ status: 'ready' as const, value: defaultSoundSettings(), writable: true }), subscribe: () => () => {}, set: vi.fn(() => Promise.resolve()) }) })
      declareRoot(ctx.slots)
      const fiber = await ctx.plugin({ apply, inject }).await()

      await vi.advanceTimersByTimeAsync(800 + 800)
      const opensAtTrip = opens
      await vi.advanceTimersByTimeAsync(55_000)
      expect(opens).toBe(opensAtTrip)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(opens).toBeGreaterThan(opensAtTrip)

      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
