/** Test bench for the SkinController: in-memory doubles for every dependency. */
import { vi, type Mock } from 'vitest'
import type { SkinLibrarySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { ThemeDefinition, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SkinController, type RemoteOutcome, type SkinDeps, type SkinLibraryRemote, type ThemeFace,
} from '../src/client/controller.ts'
import type { EnvironmentSource } from '../src/client/environment.ts'
import type { SkinSettings } from '../src/client/settings.ts'
import type { EnvironmentView } from '../src/client/view.ts'
import { snapshot } from './fixtures.client.ts'

export const ok = <T>(value: T): RemoteOutcome<T> => ({ ok: true, value })
export const fail = (message: string, code = 'internal'): RemoteOutcome<never> => ({ ok: false, error: { code, message } })

/**
 * Theme service double with the semantics the controller leans on: the
 * preference is kept as chosen, and the active theme is the preference only
 * while that theme is registered (light and dark always are); otherwise the
 * system palette (light here) renders until the theme registers again.
 */
class FakeTheme implements ThemeFace {
  preference = 'system'
  readonly registered = new Map<string, ThemeDefinition>()
  layer: ThemeTokenOverrides | undefined
  readonly layerHistory: ThemeTokenOverrides[] = []
  changed: () => void = () => {}

  get activeId(): string {
    const named = this.preference === 'light' || this.preference === 'dark' || this.registered.has(this.preference)
    return named ? this.preference : 'light'
  }

  getTheme() {
    return { preference: this.preference, active: { id: this.activeId } }
  }

  setTheme(id: string): void {
    if (id !== 'system' && id !== 'light' && id !== 'dark' && !this.registered.has(id)) {
      throw new Error(`theme "${id}" is not registered`)
    }
    this.preference = id
    this.changed()
  }

  register = vi.fn((definition: ThemeDefinition) => {
    if (this.registered.has(definition.id)) throw new Error(`theme "${definition.id}" is already registered`)
    this.registered.set(definition.id, definition)
    this.changed()
    return () => {
      this.registered.delete(definition.id)
      this.changed()
    }
  })

  overrideTokens = vi.fn((_source: string, tokens: ThemeTokenOverrides) => {
    this.layer = tokens
    this.layerHistory.push(tokens)
    this.changed()
    return () => {
      if (this.layer !== tokens) return
      this.layer = undefined
      this.changed()
    }
  })
}

/** Environment source double with manual flips. */
class FakeEnvironment implements EnvironmentSource {
  value: EnvironmentView = { reducedTransparency: false, highContrast: false }
  readonly listeners = new Set<() => void>()
  snapshot(): EnvironmentView { return this.value }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(patch: Partial<EnvironmentView>): void {
    this.value = { ...this.value, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

export interface BenchOptions {
  list?: RemoteOutcome<SkinLibrarySnapshot>
  locale?: 'zh' | 'en'
}

/** The doubles of one {@link makeBench} call, spelled out so the declaration emit names no vitest internals. */
export interface Bench {
  controller: SkinController
  theme: FakeTheme
  scope: ReturnType<typeof stubSettingsScope<SkinSettings>>
  environment: FakeEnvironment
  locale: { active: 'zh' | 'en' }
  remote: { [K in keyof SkinLibraryRemote]: Mock<SkinLibraryRemote[K]> }
  deps: SkinDeps & {
    urls: { create: Mock<SkinDeps['urls']['create']>; revoke: Mock<SkinDeps['urls']['revoke']> }
    readBase64: Mock<SkinDeps['readBase64']>
    readText: Mock<SkinDeps['readText']>
    download: Mock<SkinDeps['download']>
    warn: Mock<SkinDeps['warn']>
  }
}

/** A controller wired to doubles, with the `theme/change` echo connected. */
export function makeBench(options: BenchOptions = {}): Bench {
  const theme = new FakeTheme()
  const scope = stubSettingsScope<SkinSettings>()
  const environment = new FakeEnvironment()
  const locale = { active: options.locale ?? 'zh' }
  const remote = {
    list: vi.fn<SkinLibraryRemote['list']>(async () => options.list ?? ok(snapshot())),
    readWallpaper: vi.fn<SkinLibraryRemote['readWallpaper']>(async () => ok(undefined)),
    importPack: vi.fn<SkinLibraryRemote['importPack']>(async () => ok({ status: 'imported', skin: snapshot().skins[0]! })),
    removePack: vi.fn<SkinLibraryRemote['removePack']>(async () => ok(true)),
    putWallpaper: vi.fn<SkinLibraryRemote['putWallpaper']>(async () => ok({ status: 'stored', wallpaper: snapshot().wallpapers[0]! })),
    removeWallpaper: vi.fn<SkinLibraryRemote['removeWallpaper']>(async () => ok(true)),
  } satisfies SkinLibraryRemote
  const deps = {
    theme,
    remote,
    scope: scope.scope,
    locale: { getLocale: () => locale },
    environment,
    urls: { create: vi.fn(() => 'blob:wp'), revoke: vi.fn() },
    readBase64: vi.fn(async () => 'AAAA'),
    readText: vi.fn(async () => '{"pack":true}'),
    download: vi.fn(),
    warn: vi.fn(),
  } satisfies SkinDeps
  const controller = new SkinController(deps)
  theme.changed = () => { controller.sync() }
  return { controller, theme, scope, environment, locale, remote, deps }
}

/** Mark the scope ready and writable with the given section. */
export function ready(bench: Bench, value: Partial<SkinSettings> = {}, writable = true): void {
  bench.scope.publish({ status: 'ready', writable, value: { ...DEFAULTS, ...value } })
}

const DEFAULTS: SkinSettings = {
  accent: '', wallpaper: '', wallpaperBlur: 0, panelOpacity: 0.82, composerOpacity: 0.9, popoverOpacity: 0.96, material: 'off',
}
