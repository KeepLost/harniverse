/** Static Agent Profile recipe discovery and Loader patch compilation. */

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {
  CapabilityCatalogEntry,
  CapabilityCustomizationDescriptor,
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityMemberDescriptor,
} from '@deepseek-ai/dsh-capabilities'
import type { AgentPreset } from './preset.ts'

const RECIPE_PREFIX = 'plugin:'
const FIXED_ROWS = new Set(['agent-instructions'])

const TOOLS_BY_PACKAGE: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-agent-tool-presentation': [],
  '@deepseek-ai/dsh-compaction-tool-result-pruner': [],
  '@deepseek-ai/dsh-plan-mode': ['exit_plan_mode'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-bash-persistent': ['bash'],
  '@deepseek-ai/dsh-tool-compaction-history': ['compaction_history_expand', 'compaction_history_search'],
  '@deepseek-ai/dsh-tool-cordis': ['cordis_define', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self', 'cordis_run', 'cordis_stop', 'cordis_undefine'],
  '@deepseek-ai/dsh-tool-fs': ['edit', 'read', 'read_image', 'write'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  '@deepseek-ai/dsh-tool-jobs': ['job_kill', 'job_list', 'job_output'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-ralph': ['ralph'],
  '@deepseek-ai/dsh-tool-result-artifacts': ['artifact_read'],
  '@deepseek-ai/dsh-tool-session-delivery': ['session_send_message', 'session_unload'],
  '@deepseek-ai/dsh-tool-session-query': ['session_event_read', 'session_event_search', 'session_event_trace', 'session_find', 'session_log_tail', 'session_message_tail', 'session_search', 'session_status', 'session_trace'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-str-replace-editor': ['str_replace_editor'],
  '@deepseek-ai/dsh-tool-subagent-control': ['interrupt_agent', 'send_message'],
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': ['list_agents'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-web': ['web_fetch', 'web_search'],
  '@deepseek-ai/dsh-tool-workflow': ['workflow'],
}

/** Native Loader recipe retained only for Host-side generation compilation. */
export interface PresetCompositionRecipe {
  readonly rowId: string
  readonly canonical: EntryOptions
  readonly canonicalBaseUrl: string
  readonly source?: EntryOptions
  readonly sourceBaseUrl?: string
}

interface CompositionPatch {
  id?: string
  insert?: EntryOptions[]
  config?: unknown
  disabled?: boolean
}

/** Static recipes and target-native defaults without mounting a Profile. */
export interface PresetCompositionCatalog {
  readonly descriptors: readonly CapabilityDescriptor[]
  readonly recipes: ReadonlyMap<string, PresetCompositionRecipe>
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

function memberId(rowId: string, kind: CapabilityMemberDescriptor['kind'], name: string): string {
  return `${RECIPE_PREFIX}${rowId}/${kind}:${name}`
}

interface RecipeToolMember {
  readonly name: string
  readonly visible: boolean
}

function toolsOf(row: EntryOptions): RecipeToolMember[] {
  if (row.group && Array.isArray(row.config)) return row.config.flatMap(child => toolsOf(child as EntryOptions))
  if (row.name === '@deepseek-ai/dsh-tool-subagent') {
    const config = row.config as { toolName?: unknown } | undefined
    return [{ name: typeof config?.toolName === 'string' ? config.toolName : 'subagent', visible: row.disabled !== true }]
  }
  const config = row.config as { search?: unknown; fetch?: unknown } | undefined
  return [...TOOLS_BY_PACKAGE[row.name] ?? []].map(name => ({
    name,
    visible: row.disabled !== true
      && (row.name !== '@deepseek-ai/dsh-tool-web'
        || name === 'web_search' && config?.search === true
        || name === 'web_fetch' && config?.fetch === true),
  }))
}

function membersOf(rowId: string, row: EntryOptions): CapabilityMemberDescriptor[] | undefined {
  const byName = new Map<string, boolean>()
  for (const tool of toolsOf(row)) byName.set(tool.name, (byName.get(tool.name) ?? false) || tool.visible)
  const tools = [...byName]
  if (tools.length === 0) return undefined
  return tools.map(([name, visible]) => ({
    id: memberId(rowId, 'tool', name),
    kind: 'tool',
    name,
    description: `Built-in tool ${name}`,
    defaultVisible: visible,
    available: true,
    requires: [],
  }))
}

function customizationOf(rowId: string, row: EntryOptions): CapabilityCustomizationDescriptor | undefined {
  if (rowId !== 'persona') return undefined
  const config = row.config as { text?: unknown; complete?: unknown; includeRuntimeContext?: unknown } | undefined
  return {
    fields: [{
      id: 'text',
      kind: 'text',
      name: 'Persona',
      description: 'Identity and behavioral context contributed to the system prompt.',
      required: true,
      multiline: true,
    }, {
      id: 'complete',
      kind: 'boolean',
      name: 'Complete system prompt',
      description: 'Suppress every other system-prompt section.',
    }, {
      id: 'includeRuntimeContext',
      kind: 'boolean',
      name: 'Runtime context',
      description: 'Include dynamic runtime-context snapshots.',
    }],
    defaultValues: {
      text: typeof config?.text === 'string' ? config.text : '',
      complete: config?.complete === true,
      includeRuntimeContext: config?.includeRuntimeContext !== false,
    },
  }
}

function rowWithMemberSelection(
  row: EntryOptions,
  visible: ReadonlySet<string>,
  nested = false,
): EntryOptions {
  const configured = structuredClone(row)
  if (configured.group && Array.isArray(configured.config)) {
    configured.config = configured.config.map(child => rowWithMemberSelection(child as EntryOptions, visible, true))
    return configured
  }
  const tools = toolsOf(configured).map(member => member.name)
  if (configured.name === '@deepseek-ai/dsh-tool-web') {
    configured.config = {
      ...(configured.config as Record<string, unknown> | undefined),
      search: visible.has('web_search'),
      fetch: visible.has('web_fetch'),
    }
  }
  if (nested && tools.length > 0) configured.disabled = !tools.some(name => visible.has(name))
  return configured
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
  const canonical = new Map<string, { row: EntryOptions; baseUrl: string }>()
  for (const { preset, rows } of parsed) {
    for (const row of rows) {
      if (canonical.has(row.id)) continue
      canonical.set(row.id, { row, baseUrl: pathToFileURL(preset.path).href })
    }
  }
  const targetPreset = parsed.find(candidate => candidate.preset.id === targetProfile)
  const targetBaseUrl = targetPreset === undefined ? undefined : pathToFileURL(targetPreset.preset.path).href
  const targetRows = new Map(
    (targetPreset?.rows ?? [])
      .map(row => [row.id, row] as const),
  )
  const recipes = new Map<string, PresetCompositionRecipe>()
  const descriptors: CapabilityDescriptor[] = []
  for (const [rowId, canonicalRecipe] of canonical) {
    const { row } = canonicalRecipe
    const id = `${RECIPE_PREFIX}${rowId}`
    const source = targetRows.get(rowId)
    const loadedByDefault = targetProfile === undefined
      ? parsed.some(candidate => defaultLoaded(candidate.rows.find(entry => entry.id === rowId)))
      : defaultLoaded(source)
    const members = membersOf(rowId, source ?? row)
    const customization = customizationOf(rowId, source ?? row)
    recipes.set(id, {
      rowId,
      canonical: row,
      canonicalBaseUrl: canonicalRecipe.baseUrl,
      ...source === undefined || targetBaseUrl === undefined ? {} : {
        source,
        sourceBaseUrl: targetBaseUrl,
      },
    })
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
      ...rowId === 'persona' ? { selectionManageable: false } : {},
      owner: row.name,
      requires: dependenciesOf(rowId),
      ...members === undefined ? {} : { members },
      ...customization === undefined ? {} : { customization },
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
  const patches: CompositionPatch[] = []
  for (const entry of entries) {
    if (!entry.manageable || !entry.assembleable) continue
    const recipe = catalog.recipes.get(entry.id)
    if (recipe === undefined) continue
    const sourceLoaded = defaultLoaded(recipe.source)
    const visibleMembers = new Set(entry.memberEntries?.filter(member => member.visible).map(member => member.name) ?? [])
    const memberConfigured = entry.memberSelection === 'custom'
      ? rowWithMemberSelection(recipe.source ?? recipe.canonical, visibleMembers)
      : undefined
    const memberConfiguration = memberConfigured?.config as unknown
    const configuration = entry.effectiveConfig === undefined
      ? memberConfiguration
      : memberConfiguration !== null && typeof memberConfiguration === 'object' && !Array.isArray(memberConfiguration)
        ? { ...memberConfiguration, ...entry.effectiveConfig }
        : entry.effectiveConfig
    if (recipe.source !== undefined) {
      const patch: CompositionPatch = { id: recipe.rowId }
      if (entry.selected !== sourceLoaded) patch.disabled = entry.selected ? false : true
      if (configuration !== undefined) patch.config = structuredClone(configuration)
      if (Object.keys(patch).length > 1) patches.push(patch)
      continue
    }
    if (!entry.selected) continue
    const inserted = structuredClone(recipe.canonical)
    inserted.disabled = false
    if (configuration !== undefined) inserted.config = structuredClone(configuration)
    patches.push({ insert: [inserted] })
  }
  return patches
}
