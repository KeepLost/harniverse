/**
 * Skin pack contract: the skinnable-token allowlist, the strict colour
 * grammar, and a pure validator that turns pack text into a normalized
 * {@link SkinDefinition} or a list of human-readable issues. Two formats are
 * accepted: the native `harniverse.skin` v1 document and the
 * `dsh-dream-skin/pack` v1 compatibility envelope.
 *
 * Nothing here touches the filesystem. A value that passes validation is safe
 * to embed in a CSS custom property and in an inline script: the grammar is a
 * whitelist of hex colours, `rgb()`/`rgba()`/`hsl()`/`hsla()` numbers, and
 * `transparent`, so no reference, function, string, or delimiter survives.
 * @module @deepseek-ai/dsh-host-skin-library/pack
 */

import { BUILTIN_SKIN_IDS } from './palette.ts'
import type {
  SkinBackground, SkinColorScheme, SkinDefinition, SkinGradientLayer, SkinGradientStop, SkinName,
} from './types.ts'

/** `format` of the native pack document. */
export const PACK_FORMAT = 'harniverse.skin'

/** `format` of the dsh-dream-skin compatibility envelope. */
export const DREAM_SKIN_FORMAT = 'dsh-dream-skin/pack'

/** The only pack version either format may declare. */
const PACK_VERSION = 1

/** Largest accepted pack document, in UTF-8 bytes. */
export const MAX_PACK_BYTES = 256 * 1024

/** Most token entries one pack may declare. */
export const MAX_PACK_TOKENS = 40

/** Most layers in a pack's gradient background. */
export const MAX_GRADIENT_LAYERS = 6

/** Most colour stops in one gradient layer. */
export const MAX_GRADIENT_STOPS = 8

/** Longest accepted colour value, in characters. */
const MAX_COLOR_LENGTH = 64

/** Longest accepted display name, in UTF-16 code units. */
const MAX_NAME_LENGTH = 60

/** Longest accepted author, in UTF-16 code units. */
const MAX_AUTHOR_LENGTH = 80

/** Longest accepted description, in UTF-16 code units. */
const MAX_DESCRIPTION_LENGTH = 240

/** Issues kept per rejected pack; later ones are dropped. */
const MAX_ISSUES = 20

/** Shape of a skin id; the registered theme id is `skin:<id>`. */
export const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Custom properties a skin may set, in emission order. */
export const SKINNABLE_TOKENS: readonly string[] = [
  '--dsw-accent',
  '--dsw-accent-hover',
  '--dsw-accent-soft',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-specific-input-major',
  '--dsw-specific-tip',
  '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight',
  '--dsw-specific-selector',
  '--dsw-specific-menu',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-sidebar-nav-item-active',
  '--dsw-specific-sidebar-nav-item-hover',
]

/** Tokens every skin must define. */
export const CORE_TOKENS: readonly string[] = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-accent',
]

const SKINNABLE_SET: ReadonlySet<string> = new Set(SKINNABLE_TOKENS)

/** Dream-skin tokens whose accent meaning feeds the accent family when a compat pack omits it. */
const COMPAT_ACCENT_SOURCES: ReadonlyArray<readonly [target: string, source: string]> = [
  ['--dsw-accent', '--dsw-alias-brand-primary'],
  ['--dsw-accent-hover', '--dsw-alias-button-primary-hover'],
  ['--dsw-accent-soft', '--dsw-alias-button-primary-dimmed'],
]

const NATIVE_KEYS: readonly string[] = [
  'format', 'version', 'id', 'name', 'author', 'description', 'colorScheme', 'accent', 'tokens', 'background',
]

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?`
const SEPARATOR = String.raw`(?: *, *| +)`
const ALPHA_SEPARATOR = String.raw`(?: *, *| *\/ *| +)`
// Literal spaces only: `\s` would admit line separators and no-break spaces.
const FUNCTIONAL_COLOR = new RegExp(
  String.raw`^(?:rgb|rgba|hsl|hsla)\( *${NUMBER}${SEPARATOR}${NUMBER}${SEPARATOR}${NUMBER}(?:${ALPHA_SEPARATOR}${NUMBER})? *\)$`,
  'i',
)
const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * Test a value against the skin colour grammar: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()` with three or four plain
 * numbers (optional `%`; comma, space, or `/ alpha` separated), or
 * `transparent`. References, functions, named colours, escapes, quotes, and
 * delimiters never match.
 * @param value - candidate colour.
 * @returns whether `value` is a string within the grammar.
 */
export function isSkinColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_COLOR_LENGTH) return false
  return /^transparent$/i.test(value) || HEX_COLOR.test(value) || FUNCTIONAL_COLOR.test(value)
}

type Report = (issue: string) => void
type Dict = Readonly<Record<string, unknown>>

/** The candidate fields of one pack, each present only when it validated. */
interface Fields {
  id?: string | undefined
  name?: SkinName | undefined
  author?: string | undefined
  description?: string | undefined
  colorScheme?: SkinColorScheme | undefined
  accent?: string | undefined
  tokens?: Record<string, string> | undefined
  background?: SkinBackground | undefined
}

/** Outcome of {@link parseSkinPack}. */
type SkinPackParse =
  | { readonly ok: true; readonly skin: SkinDefinition }
  | {
    readonly ok: false
    /** One human-readable reason per violated rule; never empty. */
    readonly issues: readonly string[]
  }

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Quote untrusted text for a message, truncating long input. */
function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)
}

/** Describe untrusted input for a message without echoing non-text values. */
function describe(value: unknown): string {
  return typeof value === 'string' ? quote(value) : typeof value
}

function rejectUnknownKeys(dict: Dict, allowed: readonly string[], where: string, report: Report): void {
  for (const key of Object.keys(dict)) {
    if (!allowed.includes(key)) report(`${where}: unknown key ${quote(key)}`)
  }
}

function readText(value: unknown, label: string, min: number, max: number, report: Report): string | undefined {
  if (typeof value !== 'string') {
    report(`${label} must be a string`)
    return undefined
  }
  const text = value.trim()
  if (CONTROL_CHARACTERS.test(text)) {
    report(`${label} must not contain control characters`)
    return undefined
  }
  if (text.length < min) {
    report(`${label} must not be empty`)
    return undefined
  }
  if (text.length > max) {
    report(`${label} is longer than ${max} characters`)
    return undefined
  }
  return text
}

/** Optional text: absent or blank means "not set". */
function readOptionalText(value: unknown, label: string, max: number, report: Report): string | undefined {
  if (value === undefined) return undefined
  const text = readText(value, label, 0, max, report)
  return text === '' ? undefined : text
}

function readId(value: unknown, report: Report): string | undefined {
  if (typeof value !== 'string' || !SKIN_ID_PATTERN.test(value)) {
    report(`id must match ${String(SKIN_ID_PATTERN)}`)
    return undefined
  }
  if (BUILTIN_SKIN_IDS.has(value)) {
    report(`id ${quote(value)} belongs to a built-in skin`)
    return undefined
  }
  return value
}

function readName(value: unknown, report: Report): SkinName | undefined {
  if (typeof value === 'string') {
    const text = readText(value, 'name', 1, MAX_NAME_LENGTH, report)
    return text === undefined ? undefined : { zh: text, en: text }
  }
  if (!isRecord(value)) {
    report('name must be a string or an object with zh and en strings')
    return undefined
  }
  rejectUnknownKeys(value, ['zh', 'en'], 'name', report)
  const zh = readText(value.zh, 'name.zh', 1, MAX_NAME_LENGTH, report)
  const en = readText(value.en, 'name.en', 1, MAX_NAME_LENGTH, report)
  return zh === undefined || en === undefined ? undefined : { zh, en }
}

function readColorScheme(value: unknown, report: Report): SkinColorScheme | undefined {
  if (value === 'light' || value === 'dark') return value
  report('colorScheme must be "light" or "dark"')
  return undefined
}

function readAccent(value: unknown, report: Report): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && ACCENT_PATTERN.test(value)) return value.toLowerCase()
  report(`accent ${describe(value)} must be a #rrggbb colour`)
  return undefined
}

function readColor(value: unknown, label: string, report: Report): string | undefined {
  if (isSkinColor(value)) return value
  report(`${label} ${describe(value)} is not a supported colour (use #hex, rgb(), rgba(), hsl(), hsla(), or transparent)`)
  return undefined
}

function readNumber(value: unknown, label: string, min: number, max: number, report: Report): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value
  report(`${label} must be a number from ${min} to ${max}`)
  return undefined
}

function readPoint(value: unknown, label: string, report: Report): readonly [x: number, y: number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    report(`${label} must be [x, y]`)
    return undefined
  }
  const [rawX, rawY] = value as unknown[]
  const x = readNumber(rawX, `${label}[0]`, 0, 100, report)
  const y = readNumber(rawY, `${label}[1]`, 0, 100, report)
  return x === undefined || y === undefined ? undefined : [x, y]
}

function readStops(value: unknown, label: string, report: Report): SkinGradientStop[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_GRADIENT_STOPS) {
    report(`${label} must list 2 to ${MAX_GRADIENT_STOPS} stops`)
    return undefined
  }
  const stops: SkinGradientStop[] = []
  for (const [index, item] of (value as unknown[]).entries()) {
    const where = `${label}[${index}]`
    if (!Array.isArray(item) || item.length !== 2) {
      report(`${where} must be [colour, position]`)
      continue
    }
    const [rawColor, rawPosition] = item as unknown[]
    const color = readColor(rawColor, `${where} colour`, report)
    const position = readNumber(rawPosition, `${where} position`, 0, 100, report)
    if (color !== undefined && position !== undefined) stops.push([color, position])
  }
  return stops
}

function readLayer(value: unknown, label: string, report: Report): SkinGradientLayer | undefined {
  if (!isRecord(value)) {
    report(`${label} must be an object`)
    return undefined
  }
  if (value.type === 'linear') {
    rejectUnknownKeys(value, ['type', 'angle', 'stops'], label, report)
    const angle = readNumber(value.angle, `${label}.angle`, 0, 360, report)
    const stops = readStops(value.stops, `${label}.stops`, report)
    return angle === undefined || stops === undefined ? undefined : { type: 'linear', angle, stops }
  }
  if (value.type === 'radial') {
    rejectUnknownKeys(value, ['type', 'at', 'size', 'stops'], label, report)
    const at = readPoint(value.at, `${label}.at`, report)
    const size = readNumber(value.size, `${label}.size`, 1, 150, report)
    const stops = readStops(value.stops, `${label}.stops`, report)
    return at === undefined || size === undefined || stops === undefined ? undefined : { type: 'radial', at, size, stops }
  }
  report(`${label}.type must be "linear" or "radial"`)
  return undefined
}

function readBackground(value: unknown, report: Report): SkinBackground | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    report('background must be an object')
    return undefined
  }
  rejectUnknownKeys(value, ['kind', 'layers'], 'background', report)
  if (value.kind !== 'gradient') report('background.kind must be "gradient"')
  const raw = value.layers
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_GRADIENT_LAYERS) {
    report(`background.layers must list 1 to ${MAX_GRADIENT_LAYERS} layers`)
    return undefined
  }
  const layers: SkinGradientLayer[] = []
  for (const [index, item] of (raw as unknown[]).entries()) {
    const layer = readLayer(item, `background.layers[${index}]`, report)
    if (layer !== undefined) layers.push(layer)
  }
  return { kind: 'gradient', layers }
}

/**
 * Validate a token table. A native pack must name only allowlisted tokens; a
 * compat pack's other names are dropped before counting.
 */
function readTokens(value: unknown, dropUnknown: boolean, report: Report): Record<string, string> | undefined {
  if (!isRecord(value)) {
    report('tokens must be an object')
    return undefined
  }
  const names = Object.keys(value).filter(name => !dropUnknown || SKINNABLE_SET.has(name))
  if (names.length > MAX_PACK_TOKENS) report(`tokens lists ${names.length} entries; at most ${MAX_PACK_TOKENS} are allowed`)
  const tokens: Record<string, string> = {}
  for (const name of names) {
    if (!SKINNABLE_SET.has(name)) {
      report(`tokens: ${quote(name)} is not a skinnable token`)
      continue
    }
    const color = readColor(value[name], `token ${name}`, report)
    if (color !== undefined) tokens[name] = color
  }
  return tokens
}

function readNative(doc: Dict, report: Report): Fields {
  rejectUnknownKeys(doc, NATIVE_KEYS, 'pack', report)
  return {
    id: readId(doc.id, report),
    name: readName(doc.name, report),
    author: readOptionalText(doc.author, 'author', MAX_AUTHOR_LENGTH, report),
    description: readOptionalText(doc.description, 'description', MAX_DESCRIPTION_LENGTH, report),
    colorScheme: readColorScheme(doc.colorScheme, report),
    accent: readAccent(doc.accent, report),
    tokens: readTokens(doc.tokens, false, report),
    background: readBackground(doc.background, report),
  }
}

/**
 * Convert a dsh-dream-skin envelope. Its brand colour is an accent, so a
 * missing accent family is derived from the manifest accent and the brand
 * tokens; unknown manifest keys and non-allowlisted tokens are ignored.
 */
function readDreamSkin(doc: Dict, report: Report): Fields {
  const manifest = doc.manifest
  if (!isRecord(manifest)) {
    report('manifest must be an object')
    return {}
  }
  let name: SkinName | undefined
  if (manifest.name === undefined && manifest.nameZh === undefined) {
    report('manifest.name or manifest.nameZh is required')
  } else {
    name = readName({ zh: manifest.nameZh ?? manifest.name, en: manifest.name ?? manifest.nameZh }, report)
  }
  const accent = readAccent(manifest.accent, report)
  const tokens = readTokens(manifest.tokens, true, report)
  if (tokens !== undefined) {
    for (const [target, source] of COMPAT_ACCENT_SOURCES) {
      const derived = target === '--dsw-accent' ? accent ?? tokens[source] : tokens[source]
      if (tokens[target] === undefined && derived !== undefined) tokens[target] = derived
    }
  }
  return {
    id: readId(typeof manifest.id === 'string' ? manifest.id.toLowerCase() : manifest.id, report),
    name,
    author: readOptionalText(manifest.author, 'author', MAX_AUTHOR_LENGTH, report),
    description: readOptionalText(manifest.description, 'description', MAX_DESCRIPTION_LENGTH, report),
    colorScheme: readColorScheme(manifest.colorScheme, report),
    accent,
    tokens,
  }
}

/** Combine validated fields into a definition, enforcing the core-token requirement. */
function assemble(fields: Fields, report: Report): SkinDefinition | undefined {
  const { id, name, colorScheme, tokens } = fields
  if (tokens !== undefined) {
    const missing = CORE_TOKENS.filter(token => tokens[token] === undefined)
    if (missing.length > 0) report(`missing required tokens: ${missing.join(', ')}`)
  }
  if (id === undefined || name === undefined || colorScheme === undefined || tokens === undefined) return undefined
  const ordered: Record<string, string> = {}
  for (const token of SKINNABLE_TOKENS) {
    const color = tokens[token]
    if (color !== undefined) ordered[token] = color
  }
  return {
    id,
    source: 'pack',
    name,
    ...fields.author === undefined ? {} : { author: fields.author },
    ...fields.description === undefined ? {} : { description: fields.description },
    colorScheme,
    ...fields.accent === undefined ? {} : { accent: fields.accent },
    tokens: ordered,
    ...fields.background === undefined ? {} : { background: fields.background },
  }
}

/**
 * Validate and normalize one skin pack document. Never throws: every
 * violated rule becomes an issue, so a user fixes a pack in one pass.
 * @param text - the pack file contents (native `harniverse.skin` v1 or dsh-dream-skin v1).
 * @returns the normalized skin (`source: 'pack'`, tokens in allowlist order), or the issues.
 */
export function parseSkinPack(text: string): SkinPackParse {
  const issues: string[] = []
  const report: Report = (issue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue)
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_PACK_BYTES) {
    report(`the pack is ${bytes} bytes; the limit is ${MAX_PACK_BYTES} bytes`)
    return { ok: false, issues }
  }
  let doc: unknown
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    // JSON.parse only throws SyntaxError.
    report(`the pack is not valid JSON: ${(error as SyntaxError).message}`)
    return { ok: false, issues }
  }
  if (!isRecord(doc)) {
    report('the pack must be a JSON object')
    return { ok: false, issues }
  }
  if (doc.format !== PACK_FORMAT && doc.format !== DREAM_SKIN_FORMAT) {
    report(`format ${describe(doc.format)} is not supported; expected "${PACK_FORMAT}" or "${DREAM_SKIN_FORMAT}"`)
    return { ok: false, issues }
  }
  if (doc.version !== PACK_VERSION) report(`version must be ${PACK_VERSION}`)
  const fields = doc.format === PACK_FORMAT ? readNative(doc, report) : readDreamSkin(doc, report)
  const skin = assemble(fields, report)
  return skin === undefined || issues.length > 0 ? { ok: false, issues } : { ok: true, skin }
}

/**
 * Render a skin as a native pack document (`harniverse.skin` v1), the shape
 * the library stores. `parseSkinPack` accepts its output, except that a
 * built-in skin's id is reserved.
 * @param skin - the skin to write.
 * @returns pretty-printed JSON ending in one newline.
 */
export function serializeSkinPack(skin: SkinDefinition): string {
  const document = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: skin.id,
    name: skin.name,
    ...skin.author === undefined ? {} : { author: skin.author },
    ...skin.description === undefined ? {} : { description: skin.description },
    colorScheme: skin.colorScheme,
    ...skin.accent === undefined ? {} : { accent: skin.accent },
    tokens: skin.tokens,
    ...skin.background === undefined ? {} : { background: skin.background },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
