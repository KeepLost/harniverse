/**
 * Sound notification section, browser half. One `settings.section` entry
 * (id `sound`) plus its nav glyph, a frame-level watcher over a
 * supplementary mux subscription and the host stream, and the playback
 * engine. The `ui-sound` settings scope carries every durable preference;
 * local audio files stay in this browser's IndexedDB.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, IApiClient, RpcRequest } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings SlotMap merge (settings.section /
// settings.nav.icon) and the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AudioLibrary, openBrowserAudioStore } from './audio-library.ts'
import { CrossTabDedupe, type CrossTabChannel } from './cross-tab.ts'
import { SoundEngine } from './engine.ts'
import { SoundSection } from './SoundSection.tsx'
import type { SoundSectionInjected } from './SoundSection.tsx'
import { NavIcon } from './NavIcon.tsx'
import { pickAudioFile } from './pick-file.ts'
import { SoundWatcher, type WatcherStreamOpener } from './watcher.ts'
import { resolvePlayback } from './routing.ts'
import { en, NS, zh } from './locales.ts'
import type { SoundLocaleKey } from './locales.ts'
import { SOUND_SETTINGS_NAMESPACE, decodeSoundSettings } from '../sound-settings.ts'
import type { SoundSettings } from '../sound-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sound notification section copy. */
    'settings.sound': SoundLocaleKey
  }
}

/** Required services: slots, locale, sessions list, connection streams, and the settings scope. */
export const inject = ['slots', 'locale', 'sessions', 'connection', 'settingsScope']

/** One already-ended iterable: a failed open attempt backs off and reopens. */
function endedStream<F>(): AsyncIterable<RpcRequest<F>> {
  async function* ended(): AsyncIterable<RpcRequest<F>> {
    /* zero iterations: the opener failed this attempt */
  }
  return ended()
}

/**
 * Client plugin body: register the dictionaries, start the watcher and
 * engine, and contribute the settings section with its nav glyph.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sound: dictionaries')

  const scope = ctx.settingsScope.bind<SoundSettings>({
    namespace: SOUND_SETTINGS_NAMESPACE,
    decode: decodeSoundSettings,
  })

  const sessionsFace = { getSnapshot: () => ctx.sessions.list.getSnapshot() }

  const library = new AudioLibrary(openBrowserAudioStore)
  const dedupe = createCrossTabDedupe()
  const engine = new SoundEngine({ audio: lazyAudioContext, library, dedupe })

  /** Play one detected occurrence per the current settings. */
  const onEvent = (event: Parameters<typeof resolvePlayback>[1]): void => {
    const snapshot = scope.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) return
    const decision = resolvePlayback(snapshot.value, event, sessionsFace.getSnapshot().current)
    if (decision !== undefined) engine.play(decision.sound, decision.volume, decision.sourceKey)
  }

  /** Cross-tab arbitration leaves with the plugin fiber. */
  ctx.effect(() => () => {
    if (dedupe !== undefined) dedupe.dispose()
  }, 'ui-sound: cross-tab lifecycle')

  /** Stream controllers aborted when the plugin fiber leaves. */
  const controllers = new Set<AbortController>()
  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort()
  }, 'ui-sound: stream controllers')

  /** Capture the current machine's API for one stream attempt. */
  const captureApi = (): IApiClient | undefined => {
    const connection = ctx.get('connection') as ConnectionHandle
    try {
      return connection.captureApi()
    } catch {
      return undefined
    }
  }

  /** Open one fresh stream attempt; an immediate open failure ends it. */
  const openStream = <F>(open: (api: IApiClient, signal: AbortSignal) => AsyncIterable<RpcRequest<F>>): WatcherStreamOpener<F> => () => {
    const api = captureApi()
    if (api === undefined) return undefined
    const controller = new AbortController()
    controllers.add(controller)
    try {
      return open(api, controller.signal)
    } catch {
      controllers.delete(controller)
      return endedStream<F>()
    }
  }

  const watcher = new SoundWatcher({
    sessions: sessionsFace,
    openMux: openStream((api, signal) => api.events.mux({}, signal)),
    openHost: openStream((api, signal) => api.events.host({}, signal)),
    onEvent,
    schedule: (fn, ms) => { return setTimeout(fn, ms) },
    cancel: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
  })
  /**
   * Open the supplementary streams only after the shared connection reports
   * ready (plus a stagger), so boot never races the shared mux/host handshake
   * for the carrier's attention; without a health source, start immediately.
   */
  const WATCHER_STAGGER_MS = 1500
  ctx.effect(() => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    const health = connection?.health
    if (health === undefined) {
      watcher.start()
      return () => { watcher.dispose() }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const launch = (): void => {
      if (timer === undefined) timer = setTimeout(() => { watcher.start() }, WATCHER_STAGGER_MS)
    }
    const ready = (): boolean => {
      const state = health.getSnapshot()
      return state === 'connected' || state === 'bypass'
    }
    if (ready()) launch()
    const unsubscribe = health.subscribe(() => { if (ready()) launch() })
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      watcher.dispose()
    }
  }, 'ui-sound: watcher lifecycle')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sound',
    // After the appearance family (30–70): alerting preferences close the
    // personalization group before feature sections take over.
    order: 75,
    label: () => t('nav'),
    locale: NS,
    inject: (): SoundSectionInjected => ({
      hooks: { settings: scope },
      setField: (field, value) => scope.set(field, value),
      chooseFile: async () => {
        const file = await pickAudioFile()
        if (file === undefined) return undefined
        return await library.save(file, file.name)
      },
      audioName: async (value) => {
        if (!value.startsWith('audio:')) return ''
        const record = await library.load(value.slice('audio:'.length))
        return record?.name ?? ''
      },
      preview: (value, volume) => { engine.play(value, volume) },
    }),
  }, SoundSection))
  ctx.slots.inject('settings.nav.icon', () => ctx.slots.register({
    name: 'settings.nav.icon',
    key: 'sound',
  }, NavIcon))
}

/** Build the cross-tab arbitration participant when the platform provides the channel. */
function createCrossTabDedupe(): CrossTabDedupe | undefined {
  const carrier = globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannel }
  if (carrier.BroadcastChannel === undefined) return undefined
  try {
    return new CrossTabDedupe(new carrier.BroadcastChannel('dsh-ui-sound') as unknown as CrossTabChannel)
  } catch {
    return undefined
  }
}

/** Lazily create this tab's Web Audio context when the platform provides it. */
function lazyAudioContext(): AudioContext | undefined {
  const carrier = globalThis as { AudioContext?: new () => AudioContext }
  return carrier.AudioContext === undefined ? undefined : new carrier.AudioContext()
}
