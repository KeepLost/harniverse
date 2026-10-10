/** Shared builders for the ui-skin specs. */
import type {
  SkinBackground, SkinDefinition, SkinLibrarySnapshot, WallpaperEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import { DEFAULT_LIMITS, type LibraryView } from '../src/client/view.ts'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)

const CORE_TOKENS = {
  '--dsw-alias-bg-base': '#101014',
  '--dsw-alias-bg-layer-1': '#18181e',
  '--dsw-alias-label-primary': '#f4f4f8',
  '--dsw-alias-label-secondary': '#b8b8c4',
  '--dsw-alias-border-l1': '#2a2a34',
  '--dsw-alias-border-l2': '#3a3a46',
  '--dsw-accent': '#5e6ad2',
} as const

export const GRADIENT: SkinBackground = {
  kind: 'gradient',
  layers: [
    { type: 'radial', at: [20, 10], size: 60, stops: [['#5e6ad240', 0], ['transparent', 100]] },
    { type: 'linear', angle: 165, stops: [['#121216', 0], ['#101016', 100]] },
  ],
}

/** A skin patch where `undefined` removes the field (optional fields cannot hold undefined). */
export type SkinPatch = { [K in keyof SkinDefinition]?: SkinDefinition[K] | undefined }

/** A dark built-in-shaped skin; override any field, or pass `undefined` to drop an optional one. */
export function skin(id: string, patch: SkinPatch = {}): SkinDefinition {
  const merged = {
    id,
    source: 'builtin',
    name: { zh: `${id}中文`, en: `${id} en` },
    colorScheme: 'dark',
    accent: '#5e6ad2',
    tokens: { ...CORE_TOKENS },
    ...patch,
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as unknown as SkinDefinition
}

export function wallpaper(hash: string, patch: Partial<WallpaperEntry> = {}): WallpaperEntry {
  return { hash, mime: 'image/png', bytes: 2048, addedAt: Date.UTC(2026, 9, 9, 8, 30), ...patch }
}

/** A snapshot as `skinLibrary.list` answers it. */
export function snapshot(patch: Partial<SkinLibrarySnapshot> = {}): SkinLibrarySnapshot {
  return {
    skins: [skin('abyss', { background: GRADIENT }), skin('ivory', { colorScheme: 'light' })],
    wallpapers: [wallpaper(HASH_A), wallpaper(HASH_B, { mime: 'image/webp' })],
    rejected: [],
    limits: DEFAULT_LIMITS,
    ...patch,
  }
}

/** The same content as a ready library slice. */
export function libraryView(patch: Partial<LibraryView> = {}): LibraryView {
  const { skins, wallpapers, rejected, limits } = snapshot()
  return { status: 'ready', skins, wallpapers, rejected, limits, ...patch }
}
