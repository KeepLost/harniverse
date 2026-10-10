/**
 * Skin pack export. A pack is the `harniverse.skin` v1 document the Host
 * imports; exporting the active skin builds that document from the definition
 * the catalog served, so the file round-trips through `importPack`.
 * @module @deepseek-ai/dsh-client-ui-skin/pack
 */
import type { SkinDefinition } from '@deepseek-ai/dsh-api-remotes/client'

/** Document format tag. */
export const PACK_FORMAT = 'harniverse.skin'

/** Document format version. */
export const PACK_VERSION = 1

/** Longest pack id the Host accepts. */
const MAX_PACK_ID = 40

/** Suffix that keeps an exported built-in from colliding with its own id on re-import. */
const COPY_SUFFIX = '-copy'

/** A built, ready-to-download pack file. */
export interface ExportedPack {
  /** Suggested download name, `<id>.json`. */
  fileName: string
  /** The pretty-printed document, newline-terminated. */
  text: string
}

/**
 * Build the pack document of a skin. A built-in skin's id is reserved by the
 * Host, so it exports as an editable copy under `<id>-copy`; an imported pack
 * exports under its own id and re-imports as a replacement.
 * @param skin - the catalog skin to export.
 * @returns the file name and document text.
 */
export function exportPack(skin: SkinDefinition): ExportedPack {
  const builtin = skin.source === 'builtin'
  const id = builtin ? `${skin.id.slice(0, MAX_PACK_ID - COPY_SUFFIX.length)}${COPY_SUFFIX}` : skin.id
  const document = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id,
    name: builtin ? { zh: `${skin.name.zh}（副本）`, en: `${skin.name.en} (copy)` } : { zh: skin.name.zh, en: skin.name.en },
    ...skin.author === undefined ? {} : { author: skin.author },
    ...skin.description === undefined ? {} : { description: skin.description },
    colorScheme: skin.colorScheme,
    ...skin.accent === undefined ? {} : { accent: skin.accent },
    tokens: skin.tokens,
    ...skin.background === undefined ? {} : { background: skin.background },
  }
  return { fileName: `${id}.json`, text: `${JSON.stringify(document, null, 2)}\n` }
}
