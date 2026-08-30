import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compositionCatalog,
  compositionPatches,
  type AgentPreset,
} from '@deepseek-ai/dsh-agent-presets'
import type { CapabilityCatalogEntry, CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'

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

  it('keeps code-only presentation opt-in in the global catalog and exposes run_code as a member', async () => {
    const presets = ['standard', 'minimal', 'code', 'cordis'].map(shippedPreset)
    const global = await compositionCatalog(presets)
    const presentation = global.descriptors.find(entry => entry.id === 'plugin:tool-presentation')

    expect(presentation?.defaultLoaded).toBe(false)
    expect(presentation?.members).toContainEqual(expect.objectContaining({
      name: 'run_code',
      defaultVisible: true,
    }))
  })

  it('does not insert code presentation into standard when its native defaults are selected', async () => {
    const presets = ['standard', 'minimal', 'code', 'cordis'].map(shippedPreset)
    const catalog = await compositionCatalog(presets, 'standard')
    const patches = compositionPatches(catalog, catalog.descriptors.map(descriptor => selected(descriptor)))

    expect(patches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ insert: [expect.objectContaining({ id: 'tool-presentation' })] }),
    ]))
  })

  it('compiles run_code member selection into an enabled or disabled presentation row', async () => {
    const catalog = await compositionCatalog(['standard', 'code'].map(shippedPreset), 'standard')
    const presentation = catalog.descriptors.find(entry => entry.id === 'plugin:tool-presentation')
    if (presentation?.members === undefined) throw new Error('tool presentation must declare run_code')
    const entryFor = (visible: boolean): CapabilityCatalogEntry[] => catalog.descriptors.map(descriptor => descriptor.id === 'plugin:tool-presentation'
      ? {
        ...selected(descriptor, true),
        memberSelection: 'custom',
        memberEntries: descriptor.members!.map(member => ({ ...member, visible })),
      }
      : selected(descriptor))

    expect(compositionPatches(catalog, entryFor(true))).toContainEqual({
      insert: [expect.objectContaining({ id: 'tool-presentation', disabled: false })],
    })
    expect(compositionPatches(catalog, entryFor(false))).toContainEqual({
      insert: [expect.objectContaining({ id: 'tool-presentation', disabled: true })],
    })
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
})
