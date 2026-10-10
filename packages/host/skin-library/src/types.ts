/**
 * Public wire vocabulary of the skin library Remote: skin definitions (built
 * in or imported from a pack), the content-addressed wallpaper catalog, and
 * the per-call outcomes the client discriminates on. Types only — no runtime
 * code.
 * @module @deepseek-ai/dsh-host-skin-library/types
 */

/** Which base palette a skin builds on; it drives `body[data-ds-dark-theme]`. */
export type SkinColorScheme = 'light' | 'dark'

/** Where a skin comes from: shipped with the product or imported from a pack. */
export type SkinSource = 'builtin' | 'pack'

/** Display name in each shipped product language. */
export interface SkinName {
  readonly zh: string
  readonly en: string
}

/** One gradient colour stop: a colour from the skin colour grammar and a position in percent (0..100). */
export type SkinGradientStop = readonly [color: string, position: number]

/** One layer of a structured gradient background. Layers paint first-listed on top. */
export type SkinGradientLayer =
  | {
    readonly type: 'linear'
    /** CSS angle in degrees, 0..360. */
    readonly angle: number
    readonly stops: readonly SkinGradientStop[]
  }
  | {
    readonly type: 'radial'
    /** Centre as percentages of the backdrop box, `[x, y]`, 0..100. */
    readonly at: readonly [x: number, y: number]
    /** Radius as a percentage of the larger backdrop side, 1..150. */
    readonly size: number
    readonly stops: readonly SkinGradientStop[]
  }

/** A skin's own backdrop: a structured gradient rendered by the shell backdrop seat. */
export interface SkinBackground {
  readonly kind: 'gradient'
  readonly layers: readonly SkinGradientLayer[]
}

/** One selectable skin as the client registers it. */
export interface SkinDefinition {
  /** Stable id (`^[a-z0-9][a-z0-9-]{0,39}$`); the registered theme id is `skin:<id>`. */
  readonly id: string
  readonly source: SkinSource
  readonly name: SkinName
  readonly author?: string
  readonly description?: string
  readonly colorScheme: SkinColorScheme
  /** Accent the skin suggests (`#rrggbb`); a user accent overrides it. */
  readonly accent?: string
  /** Validated `--dsw-*` colour tokens; names come from the skinnable-token allowlist. */
  readonly tokens: Readonly<Record<string, string>>
  readonly background?: SkinBackground
}

/** Image types the wallpaper store keeps, decided by file signature rather than by declared type. */
export type WallpaperMime = 'image/png' | 'image/jpeg' | 'image/webp'

/** One stored wallpaper. */
export interface WallpaperEntry {
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly hash: string
  readonly mime: WallpaperMime
  readonly bytes: number
  /** Unix epoch milliseconds of the first upload. */
  readonly addedAt: number
}

/** A pack file on disk that failed validation, so the client can say why it is not offered. */
export interface SkinPackRejection {
  /** File name relative to the packs directory. */
  readonly file: string
  readonly message: string
}

/** Ceilings the Remote enforces, so the client can pre-check before sending bytes. */
export interface SkinLibraryLimits {
  /** Largest accepted pack document, in bytes. */
  readonly maxPackBytes: number
  /** Largest accepted wallpaper, in decoded bytes. */
  readonly maxWallpaperBytes: number
  /** Most wallpapers kept at once. */
  readonly maxWallpapers: number
}

/** Everything the client needs to render the gallery and the wallpaper rows. */
export interface SkinLibrarySnapshot {
  /** Built-in skins first, then imported packs ordered by English name. */
  readonly skins: readonly SkinDefinition[]
  /** Newest upload first. */
  readonly wallpapers: readonly WallpaperEntry[]
  readonly rejected: readonly SkinPackRejection[]
  readonly limits: SkinLibraryLimits
}

/** Outcome of `importPack`. */
export type ImportPackResult =
  | {
    /** `imported` is a new id; `replaced` overwrote the pack that held the id. */
    readonly status: 'imported' | 'replaced'
    readonly skin: SkinDefinition
  }
  | {
    readonly status: 'rejected'
    /** Human-readable reasons, one per violated rule; never empty. */
    readonly issues: readonly string[]
  }

/** Why `putWallpaper` refused an upload. */
export type WallpaperRejectionReason = 'invalid-encoding' | 'too-large' | 'unsupported-type' | 'limit-reached'

/** Outcome of `putWallpaper`. */
export type PutWallpaperResult =
  | {
    /** `existing` means identical bytes were already stored. */
    readonly status: 'stored' | 'existing'
    readonly wallpaper: WallpaperEntry
  }
  | {
    readonly status: 'rejected'
    readonly reason: WallpaperRejectionReason
  }

/** Bytes of one stored wallpaper. */
export interface WallpaperContent {
  readonly mime: WallpaperMime
  /** The exact stored bytes, base64-encoded. */
  readonly contentBase64: string
}
