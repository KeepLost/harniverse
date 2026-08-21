/** Static Agent Profile recipe discovery and Loader patch compilation. */

import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { CapabilityCatalogEntry, CapabilityDescriptor, CapabilityKind } from '@deepseek-ai/dsh-capabilities'
import type { AgentPreset } from './preset.ts'

const RECIPE_PREFIX = 'plugin:'
const FIXED_ROWS = new Set(['persona', 'agent-instructions'])

interface Recipe {
  readonly rowId: string
  readonly canonical: EntryOptions
  readonly source?: EntryOptions
}

/** Static recipes and target-native defaults without mounting a Profile. */
export interface PresetCompositionCatalog {
  readonly descriptors: readonly CapabilityDescriptor[]
  readonly recipes: ReadonlyMap<string, Recipe>
}

/** Parse one already-discovered healthy composition. */
async function rowsOf(preset: AgentPreset): Promise<EntryOptions[]> {
  const parsed: unknown = load(await readFile(preset.path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`agent-presets: preset "${preset.id}" composition is not a list`)
  return parsed as EntryOptions[]
}

function kindOf(row: EntryOptions): CapabilityKind {
  const { id } = row
  if (row.name === '@deepseek-ai/dsh-mcp-client') return 'mcp-server'
  if (id === 'skill-filesystem' || id === 'tool-skill') return 'skill'
  if (id === 'delegation' || id.startsWith('tool-subagent')) return 'subagent-provider'
  return 'tool'
}

function displayName(row: EntryOptions): string {
  const packageName = row.name.startsWith('@deepseek-ai/dsh-')
    ? row.name.slice('@deepseek-ai/dsh-'.length)
    : row.name
  if (row.group) return row.id
  return packageName.startsWith('tool-') ? packageName.slice('tool-'.length) : packageName
}

function provenanceOf(name: string): CapabilityDescriptor['provenance'] {
  if (!name.startsWith('@deepseek-ai/dsh-')) return name === 'cordis:group' ? 'upstream' : 'external'
  return 'upstream'
}

function defaultLoaded(row: EntryOptions | undefined): boolean {
  return row !== undefined && row.disabled !== true
}

function portable(row: EntryOptions): boolean {
  if (row.name.startsWith('.') || row.name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(row.name)) return false
  if (!row.group || !Array.isArray(row.config)) return true
  return row.config.every(child => portable(child as EntryOptions))
}

function dependenciesOf(rowId: string): readonly string[] {
  return rowId === 'tool-skill' ? [`${RECIPE_PREFIX}skill-filesystem`] : []
}

/**
 * Build one deployment-wide recipe universe with target-native defaults.
 * Reading these files starts no plugin and creates no standing Profile generation.
 * @param presets - discovered Profiles that contribute top-level recipes.
 * @param targetProfile - Profile whose source rows determine native defaults.
 * @returns static recipes and descriptors for the requested target.
 */
export async function compositionCatalog(
  presets: readonly AgentPreset[],
  targetProfile?: string,
): Promise<PresetCompositionCatalog> {
  const healthy = presets.filter(preset => preset.broken === undefined)
  const parsed = await Promise.all(healthy.map(async preset => ({ preset, rows: await rowsOf(preset) })))
  const canonical = new Map<string, EntryOptions>()
  for (const { rows } of parsed) {
    for (const row of rows) {
      if (canonical.has(row.id)) continue
      canonical.set(row.id, row)
    }
  }
  const targetRows = new Map(
    (parsed.find(candidate => candidate.preset.id === targetProfile)?.rows ?? [])
      .map(row => [row.id, row] as const),
  )
  const recipes = new Map<string, Recipe>()
  const descriptors: CapabilityDescriptor[] = []
  for (const [rowId, row] of canonical) {
    const id = `${RECIPE_PREFIX}${rowId}`
    const source = targetRows.get(rowId)
    const loadedByDefault = targetProfile === undefined
      ? parsed.some(candidate => defaultLoaded(candidate.rows.find(entry => entry.id === rowId)))
      : defaultLoaded(source)
    recipes.set(id, { rowId, canonical: row, ...source === undefined ? {} : { source } })
    descriptors.push({
      id,
      kind: kindOf(row),
      name: displayName(row),
      description: row.group
        ? `Profile plugin group ${rowId}`
        : `Profile plugin ${row.name}`,
      provenance: provenanceOf(row.name),
      assembleable: source !== undefined || portable(row),
      available: true,
      defaultLoaded: loadedByDefault,
      manageable: !FIXED_ROWS.has(rowId),
      owner: row.name,
      requires: dependenciesOf(rowId),
    })
  }
  descriptors.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
  return { descriptors, recipes }
}

/**
 * Compile desired selections into native Include patches for one generation.
 * @param catalog - target Profile recipes and source rows.
 * @param entries - effective selections to compile.
 * @returns patches that disable source rows or insert portable recipes.
 */
export function compositionPatches(
  catalog: PresetCompositionCatalog,
  entries: readonly CapabilityCatalogEntry[],
): PatchOptions[] {
  const patches: PatchOptions[] = []
  for (const entry of entries) {
    if (!entry.manageable || !entry.assembleable) continue
    const recipe = catalog.recipes.get(entry.id)
    if (recipe === undefined) continue
    const sourceLoaded = defaultLoaded(recipe.source)
    if (recipe.source !== undefined) {
      if (entry.selected !== sourceLoaded) {
        patches.push({ id: recipe.rowId, disabled: entry.selected ? false : true })
      }
      continue
    }
    if (!entry.selected) continue
    patches.push({ insert: [{ ...structuredClone(recipe.canonical), disabled: false }] })
  }
  return patches
}
