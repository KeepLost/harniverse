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

  it('compiles unloads and cross-Profile loads into native Include patches', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard'), shippedPreset('minimal')], 'minimal')
    const entries = catalog.descriptors.map(descriptor => selected(
      descriptor,
      descriptor.id === 'plugin:tool-bash' ? true : descriptor.defaultLoaded,
    ))
    const patches = compositionPatches(catalog, entries)

    expect(patches).toEqual(expect.arrayContaining([
      expect.objectContaining({ insert: [expect.objectContaining({ id: 'tool-bash', disabled: false })] }),
    ]))
  })

  it('describes built-in tools and Profile-safe persona configuration without mounting plugins', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const filesystem = catalog.descriptors.find(entry => entry.id === 'plugin:tool-fs')
    expect(filesystem?.members?.map(member => member.name)).toEqual(['edit', 'read', 'read_image', 'write'])
    const persona = catalog.descriptors.find(entry => entry.id === 'plugin:persona')
    expect(persona).toMatchObject({ manageable: true, selectionManageable: false })
    expect(persona?.customization?.defaultValues).toMatchObject({
      complete: false,
      includeRuntimeContext: true,
    })
  })

  it('compiles resolved Persona configuration as a complete native row config', async () => {
    const catalog = await compositionCatalog([shippedPreset('standard')], 'standard')
    const entries = catalog.descriptors.map((descriptor): CapabilityCatalogEntry => ({
      ...selected(descriptor),
      ...descriptor.id === 'plugin:persona' ? {
        effectiveConfig: {
          text: 'You are a review specialist.',
          complete: true,
          includeRuntimeContext: false,
        },
      } : {},
    }))
    const patches = compositionPatches(catalog, entries)

    expect(patches).toContainEqual({
      id: 'persona',
      config: {
        text: 'You are a review specialist.',
        complete: true,
        includeRuntimeContext: false,
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
})
