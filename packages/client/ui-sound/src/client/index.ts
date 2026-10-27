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
import { SoundEngine } from './engine.ts'
import { SoundNotifier, type NotificationFace } from './notifier.ts'
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
  const engine = new SoundEngine({ audio: lazyAudioContext, library })
  const notifier = new SoundNotifier({
    notifications: browserNotifications(),
    alertable: () => document.visibilityState === 'visible' && document.hasFocus(),
  })

  const t = ctx.locale.bind(NS)

  /** Deliver one detected occurrence: permission-gated sound plus toast. */
  const onEvent = (event: Parameters<typeof resolvePlayback>[1]): void => {
    const snapshot = scope.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) return
    const decision = resolvePlayback(snapshot.value, event, sessionsFace.getSnapshot().current)
    if (decision === undefined) return
    const row = sessionsFace.getSnapshot().byId[event.sessionId]
    notifier.alert({
      title: t(`event.${event.kind}`),
      body: row?.displayTitle ?? '',
      onActivate: () => {
        if (sessionsFace.getSnapshot().byId[event.sessionId] !== undefined) {
          ctx.sessions.open(event.sessionId)
        }
      },
      ring: () => { engine.play(decision.sound, decision.volume, decision.sourceKey) },
    })
  }

  /** Capture the current machine's API for one stream attempt. */
  const captureApi = (): IApiClient | undefined => {
    const connection = ctx.get('connection') as ConnectionHandle
    try {
      return connection.captureApi()
    } catch {
      return undefined
    }
  }

  /** Open one fresh stream attempt bound to one generation's abort registry; an immediate open failure ends it. */
  const openStream = <F>(
    registry: Set<AbortController>,
    open: (api: IApiClient, signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): WatcherStreamOpener<F> => () => {
    const api = captureApi()
    if (api === undefined) return undefined
    const controller = new AbortController()
    registry.add(controller)
    try {
      return open(api, controller.signal)
    } catch {
      registry.delete(controller)
      return endedStream<F>()
    }
  }

  /** Build one watcher generation with its own stream abort registry; the breaker aborts the registry itself. */
  const makeWatcher = (onRetired: () => void): { watcher: SoundWatcher; abort: () => void } => {
    const registry = new Set<AbortController>()
    const retire = (): void => { for (const controller of [...registry]) controller.abort() }
    const watcher = new SoundWatcher({
      sessions: sessionsFace,
      openMux: openStream(registry, (api, signal) => api.events.mux({}, signal)),
      onEvent,
      schedule: (fn, ms) => { return setTimeout(fn, ms) },
      cancel: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
      onCarrierLost: () => { retire(); onRetired() },
    })
    return { watcher, abort: retire }
  }

  /**
   * The supplementary streams exist only while the shared connection reports
   * ready (plus a stagger, so boot never races the shared mux/host handshake);
   * when the carrier leaves the ready states — an owned Host closing, a
   * machine switch, a disconnect storm — the watcher generation is stood down
   * so it never reopens streams against a closing carrier, and a fresh
   * generation arms once readiness returns. A carrier that keeps closing
   * freshly opened streams (an owned Host draining to a quiet close while
   * the poll channel still answers) trips the generation's breaker: it is
   * retired at once and rearmed only after a cooldown, so the drain's
   * quiescence is never starved by supplementary reopens. Without a health
   * source the single generation starts immediately and lives for the
   * plugin fiber, with the same cooldown after a breaker trip.
   */
  const WATCHER_STAGGER_MS = 1500
  const CARRIER_COOLDOWN_MS = 60_000
  ctx.effect(() => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    const health = connection?.health
    if (health === undefined) {
      let cooldown: ReturnType<typeof setTimeout> | undefined
      const spawn = (): (() => void) => {
        const generation = makeWatcher(() => {
          /* the breaker fires once per live generation: arm the single cooldown rearm */
          clearTimeout(cooldown)
          cooldown = setTimeout(() => {
            cooldown = undefined
            teardown = spawn()
          }, CARRIER_COOLDOWN_MS)
        })
        generation.watcher.start()
        return () => {
          generation.watcher.dispose()
          generation.abort()
        }
      }
      let teardown: () => void = spawn()
      return () => {
        if (cooldown !== undefined) clearTimeout(cooldown)
        teardown()
      }
    }
    let generation: ReturnType<typeof makeWatcher> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const standDown = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (generation !== undefined) {
        generation.watcher.dispose()
        generation.abort()
        generation = undefined
      }
    }
    const ready = (): boolean => {
      const state = health.getSnapshot()
      return state === 'connected' || state === 'bypass'
    }
    const launch = (delay: number): void => {
      if (generation === undefined && timer === undefined) {
        /* standDown owns the only two reset paths (timer and generation), so at fire time both are clear. */
        timer = setTimeout(() => {
          timer = undefined
          if (generation === undefined && ready()) {
            generation = makeWatcher(() => {
              /* the breaker already aborted the registry; retire and arm the cooldown */
              standDown()
              launch(CARRIER_COOLDOWN_MS)
            })
            generation.watcher.start()
          }
        }, delay)
      }
    }
    if (ready()) launch(WATCHER_STAGGER_MS)
    const unsubscribe = health.subscribe(() => { if (ready()) launch(WATCHER_STAGGER_MS); else standDown() })
    return () => {
      unsubscribe()
      standDown()
    }
  }, 'ui-sound: watcher lifecycle')

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

/** Lazily create this tab's Web Audio context when the platform provides it. */
function lazyAudioContext(): AudioContext | undefined {
  const carrier = globalThis as { AudioContext?: new () => AudioContext }
  return carrier.AudioContext === undefined ? undefined : new carrier.AudioContext()
}

/**
 * Feature-detect the platform Notification API for this browser. The toast
 * stays silent (`silent: true` where honored): the alert's own chime is the
 * sound, so the OS must not layer its default notification sound on top.
 */
function browserNotifications(): NotificationFace | undefined {
  const carrier = globalThis as { Notification?: typeof Notification }
  const ctor = carrier.Notification
  if (ctor === undefined) return undefined
  return {
    permission: () => ctor.permission,
    request: () => ctor.requestPermission(),
    show: (title, body, onActivate) => {
      try {
        const toast = new ctor(title, { body, silent: true })
        toast.onclick = () => {
          window.focus()
          onActivate()
          toast.close()
        }
      } catch {
        /* a refused toast construction stays silent */
      }
    },
  }
}
