import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compositionCatalog,
  compositionPatches,
  type AgentPreset,
} from '@deepseek-ai/dsh-agent-presets'
import type { CapabilityCatalogEntry, CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One composition exercising every row classification and member shape. */
const VARIED_COMPOSITION = [
  '- id: docs-mcp',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    servers:',
  '      docs:',
  '        command: docs-server',
  '- id: delegation',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    toolName: handoff',
  '    enableChildProfileDefine: true',
  '    enableChildProfileList: true',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-preset-persona'",
  '- id: skill-filesystem',
  "  name: '@deepseek-ai/dsh-skill-filesystem'",
  '  disabled: true',
  '',
].join('\n')

const fixtures = resolve(import.meta.dirname, 'fixtures/system')
const shipped = resolve(import.meta.dirname, '../../../../apps/cli/config/agent-presets')

function preset(id: string): AgentPreset {
  return { id, trust: 'system', path: resolve(fixtures, id, 'agent.cordis.yml') }
}

function shippedPreset(id: string): AgentPreset {
  return { id, trust: 'system', path: resolve(shipped, id, 'agent.cordis.yml') }
}

function conflictPreset(): AgentPreset {
  return { id: 'conflict', trust: 'system', path: resolve(fixtures, 'conflict', 'agent.cordis.yml') }
}

function selected(descriptor: CapabilityDescriptor, value = descriptor.defaultLoaded): CapabilityCatalogEntry {
  return {
    ...descriptor,
    selection: 'inherit',
    effectiveSelection: value ? 'load' : 'unload',
    selected: value,
  }
}

describe('Agent Profile composition recipes', () => {
  it('builds one static recipe universe with Profile-native defaults without mounting plugins', async () => {
    const presets = [preset('standard'), preset('minimal')]
    const standard = await compositionCatalog(presets, 'standard')
    const minimal = await compositionCatalog(presets, 'minimal')

    expect(standard.descriptors.map(entry => entry.id)).toEqual(minimal.descriptors.map(entry => entry.id))
    expect(standard.descriptors.find(entry => entry.id === 'plugin:alpha')?.defaultLoaded).toBe(true)
    expect(minimal.descriptors.find(entry => entry.id === 'plugin:alpha')?.defaultLoaded).toBe(false)
  })

  it('keeps code-only presentation opt-in without exposing the reserved run_code transport as a member', async () => {
    const presets = ['standard', 'minimal', 'code', 'cordis'].map(shippedPreset)
    const global = await compositionCatalog(presets)
    const presentation = global.descriptors.find(entry => entry.id === 'plugin:tool-presentation')

    expect(presentation?.defaultLoaded).toBe(false)
    expect(presentation?.members).toBeUndefined()
  })

  it('does not insert code presentation into standard when its native defaults are selected', async () => {
    const presets = ['standard', 'minimal', 'code', 'cordis'].map(shippedPreset)
    const catalog = await compositionCatalog(presets, 'standard')
    const patches = compositionPatches(catalog, catalog.descriptors.map(descriptor => selected(descriptor)))

    expect(patches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ insert: [expect.objectContaining({ id: 'tool-presentation' })] }),
    ]))
  })

  it('compiles plugin selection into an enabled or disabled presentation row', async () => {
    const catalog = await compositionCatalog(['standard', 'code'].map(shippedPreset), 'standard')
    const entryFor = (loaded: boolean): CapabilityCatalogEntry[] => catalog.descriptors.map(descriptor => descriptor.id === 'plugin:tool-presentation'
      ? selected(descriptor, loaded)
      : selected(descriptor))

    expect(compositionPatches(catalog, entryFor(true))).toContainEqual({
      insert: [expect.objectContaining({ id: 'tool-presentation', disabled: false })],
    })
    expect(compositionPatches(catalog, entryFor(false))).toEqual([])
  })

  it('compiles unloads and cross-Profile loads into native Include patches', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard'), shippedPreset('minimal')], 'minimal')
    const entries = catalog.descriptors.map(descriptor => selected(
      descriptor,
      descriptor.id === 'plugin:tool-result-artifacts' ? true : descriptor.defaultLoaded,
    ))
    const patches = compositionPatches(catalog, entries)

    expect(patches).toEqual(expect.arrayContaining([
      expect.objectContaining({ insert: [expect.objectContaining({ id: 'tool-result-artifacts', disabled: false })] }),
    ]))
  })

  it('keeps a stored tool-name conflict mountable by disabling the shadowed source row', async () => {
    // `tool-bash-persistent` and `tool-bash` both register `bash`. A Profile that
    // stored both as selected must still mount: two registrations under one
    // name fail the whole generation, leaving the Session with no composition.
    const catalog = await compositionCatalog([shippedPreset('standard'), conflictPreset()], 'standard')
    const entries = catalog.descriptors.map(descriptor => selected(
      descriptor,
      descriptor.id === 'plugin:tool-bash-persistent' ? true : descriptor.defaultLoaded,
    ))
    expect(entries.filter(entry => entry.selected).map(entry => entry.id))
      .toEqual(expect.arrayContaining(['plugin:tool-bash-persistent', 'plugin:tool-bash']))

    const patches = compositionPatches(catalog, entries)

    expect(patches).toContainEqual({ id: 'tool-bash', disabled: true })
  })

  it('describes built-in tools and Profile-safe persona configuration without mounting plugins', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const filesystem = catalog.descriptors.find(entry => entry.id === 'plugin:tool-fs')
    expect(filesystem?.members?.map(member => member.name)).toEqual(['edit', 'read', 'read_image', 'write'])
    const delegation = catalog.descriptors.find(entry => entry.id === 'plugin:delegation')
    expect(delegation?.members?.filter(member => member.defaultVisible).map(member => member.name)).toEqual(expect.arrayContaining([
      'subagent', 'child_profile_define', 'child_profile_list',
    ]))
    const persona = catalog.descriptors.find(entry => entry.id === 'plugin:persona')
    expect(persona).toMatchObject({ manageable: true, selectionManageable: false })
    expect(persona?.customization?.defaultValues).toMatchObject({
      text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
    })
  })

  it('compiles resolved Persona configuration as a native row config', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const entries = catalog.descriptors.map((descriptor): CapabilityCatalogEntry => ({
      ...selected(descriptor),
      ...descriptor.id === 'plugin:persona' ? {
        effectiveConfig: {
          text: 'You are a review specialist.',
        },
      } : {},
    }))
    const patches = compositionPatches(catalog, entries)

    expect(patches).toContainEqual({
      id: 'persona',
      config: {
        text: 'You are a review specialist.',
      },
    })
  })

  it('compiles member visibility into config-gated built-in tools', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const entries = catalog.descriptors.map((descriptor): CapabilityCatalogEntry => {
      const base = selected(descriptor)
      if (descriptor.id !== 'plugin:tool-web') return base
      if (descriptor.members === undefined) throw new Error('tool-web recipe must declare members')
      return {
        ...base,
        memberSelection: 'custom',
        memberEntries: descriptor.members.map(member => ({
          ...member,
          visible: member.name === 'web_search',
        })),
      }
    })
    const patches = compositionPatches(catalog, entries)

    expect(patches).toContainEqual({
      id: 'tool-web',
      config: {
        search: true,
        fetch: false,
        searchTimeoutMs: 60000,
      },
    })
  })

  it('mounts only the selected Child Profile management member', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const entries = catalog.descriptors.map((descriptor): CapabilityCatalogEntry => {
      const base = selected(descriptor)
      if (descriptor.id !== 'plugin:delegation') return base
      if (descriptor.members === undefined) throw new Error('delegation recipe must declare members')
      return {
        ...base,
        memberSelection: 'custom',
        memberEntries: descriptor.members.map(member => ({
          ...member,
          visible: member.name === 'subagent' || member.name === 'child_profile_list',
        })),
      }
    })

    const delegation = compositionPatches(catalog, entries).find(patch => patch.id === 'delegation')
    expect(delegation).toBeDefined()
    if (delegation?.config === undefined || !Array.isArray(delegation.config)) {
      throw new Error('delegation patch must carry an entry list')
    }
    const configEntries = delegation.config as readonly unknown[]
    const subagent = configEntries.find((entry): entry is Record<string, unknown> => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      return (entry as Record<string, unknown>).id === 'tool-subagent'
    })
    expect(subagent).toBeDefined()
    expect(subagent?.config).toMatchObject({
      enableChildProfileDefine: false,
      enableChildProfileList: true,
    })
  })

  /**
   * A preset written outside the shared fixtures root. Discovery specs
   * enumerate that root, so a new directory there would change their inventory.
   */
  async function written(id: string, composition: string): Promise<AgentPreset> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-compose-'))
    roots.push(root)
    await mkdir(join(root, id))
    const path = join(root, id, 'agent.cordis.yml')
    await writeFile(path, composition)
    return { id, trust: 'system', path }
  }

  it('refuses a composition file that is not a list of rows', async () => {
    const notAList = await written('notalist', 'default: standard\n')

    await expect(compositionCatalog([notAList], 'notalist'))
      .rejects.toThrow(/composition is not a list/)
  })

  it('classifies MCP, delegation, skill, and tool rows by what each row declares', async () => {
    const varied = await written('varied', VARIED_COMPOSITION)

    const catalog = await compositionCatalog([varied], 'varied')
    const kinds = new Map(catalog.descriptors.map(descriptor => [descriptor.id, descriptor.kind]))
    expect(kinds.get('plugin:docs-mcp')).toBe('mcp-server')
    expect(kinds.get('plugin:delegation')).toBe('subagent-provider')
    expect(kinds.get('plugin:skill-filesystem')).toBe('skill')
    expect(kinds.get('plugin:persona')).toBe('tool')
  })

  it('names delegation members from the configured tool name of the row', async () => {
    const varied = await written('varied', VARIED_COMPOSITION)

    const catalog = await compositionCatalog([varied], 'varied')
    const delegation = catalog.descriptors.find(descriptor => descriptor.id === 'plugin:delegation')
    // The model-facing name is the configured one, not the plugin default.
    expect(delegation?.members?.map(member => member.name))
      .toEqual(['handoff', 'child_profile_define', 'child_profile_list'])
    expect(catalog.descriptors.find(descriptor => descriptor.id === 'plugin:skill-filesystem')?.defaultLoaded)
      .toBe(false)
  })

  it('offers an empty persona text when the row configures none', async () => {
    const varied = await written('varied', VARIED_COMPOSITION)

    const catalog = await compositionCatalog([varied], 'varied')
    expect(catalog.descriptors.find(descriptor => descriptor.id === 'plugin:persona')?.customization?.defaultValues)
      .toEqual({ text: '' })
  })
  /**
   * Two rows claiming one tool name, both native defaults of the target.
   * `bash-a` is written first, so it is the stable keeper.
   */
  const TWIN_CLAIMANTS = [
    '- id: bash-a',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    '- id: bash-b',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    '',
  ].join('\n')

  /** One delegation row whose configured name collides with its own member. */
  const SELF_CLAIMING_DELEGATION = [
    '- id: delegation',
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '  config:',
    '    toolName: child_profile_define',
    '    enableChildProfileDefine: true',
    '',
  ].join('\n')

  /** A delegation row that names no tool, so the package default stands. */
  const DEFAULT_DELEGATION = [
    '- id: delegation',
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '',
  ].join('\n')

  it('names the package default when a delegation row configures no tool name', async () => {
    const target = await written('plain', DEFAULT_DELEGATION)
    const catalog = await compositionCatalog([target], 'plain')
    const entries = catalog.descriptors.map(descriptor => selected(descriptor))

    // Reached through the shadow scan, which reads the row itself when the
    // entry carries no member selection of its own.
    expect(compositionPatches(catalog, entries)).toEqual([])
    expect(catalog.descriptors.find(descriptor => descriptor.id === 'plugin:delegation')?.members?.map(member => member.name))
      .toEqual(['subagent'])
  })

  it('records one row once when it claims the same tool name twice', async () => {
    const target = await written('selfclaim', SELF_CLAIMING_DELEGATION)
    const catalog = await compositionCatalog([target], 'selfclaim')
    const entries = catalog.descriptors.map(descriptor => selected(descriptor))

    // One row cannot shadow itself, so a repeated claim leaves no patch.
    expect(compositionPatches(catalog, entries)).toEqual([])
  })

  it('keeps the first claimant when every claimant is a native default', async () => {
    const target = await written('twins', TWIN_CLAIMANTS)
    const catalog = await compositionCatalog([target], 'twins')
    const entries = catalog.descriptors.map(descriptor => selected(descriptor))

    // Neither row was opted into over the other, so the earlier row keeps the
    // name and only the later one is disabled.
    expect(compositionPatches(catalog, entries)).toEqual([{ id: 'bash-b', disabled: true }])
  })

  it('compiles a member selection over a row this Profile does not carry', async () => {
    const other = await written('other', [
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    searchTimeoutMs: 1000',
      '',
    ].join('\n'))
    const target = await written('bare', '- id: alpha\n  name: \'@deepseek-ai/dsh-tool-bash\'\n')
    const catalog = await compositionCatalog([target, other], 'bare')
    const web = catalog.descriptors.find(descriptor => descriptor.id === 'plugin:tool-web')
    const webMembers = web?.members
    if (webMembers === undefined) throw new Error('tool-web recipe must declare members')
    const entries = catalog.descriptors.map((descriptor): CapabilityCatalogEntry => descriptor.id === 'plugin:tool-web'
      ? {
        ...selected(descriptor, true),
        memberSelection: 'custom',
        memberEntries: webMembers.map(member => ({ ...member, visible: member.name === 'web_fetch' })),
        effectiveConfig: { searchTimeoutMs: 2000 },
      }
      : selected(descriptor))

    // No source row exists, so the canonical row is inserted with the member
    // selection and the Profile configuration merged over it.
    expect(compositionPatches(catalog, entries)).toContainEqual({
      insert: [expect.objectContaining({
        id: 'tool-web',
        config: { searchTimeoutMs: 2000, search: false, fetch: true },
      })],
    })
  })

  it('compiles both polarities of a source row whose selection leaves its default', async () => {
    const target = await written('toggles', [
      '- id: on-by-default',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      '- id: off-by-default',
      "  name: '@deepseek-ai/dsh-plan-mode'",
      '  disabled: true',
      '',
    ].join('\n'))
    const catalog = await compositionCatalog([target], 'toggles')
    const entries = catalog.descriptors.map(descriptor => selected(
      descriptor,
      // Both rows are moved away from what the composition declares.
      descriptor.id === 'plugin:on-by-default' ? false : true,
    ))

    const patches = compositionPatches(catalog, entries)
    expect(patches).toContainEqual({ id: 'on-by-default', disabled: true })
    expect(patches).toContainEqual({ id: 'off-by-default', disabled: false })
  })
})
