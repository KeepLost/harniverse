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
})
