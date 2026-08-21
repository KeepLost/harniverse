import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'
import type { CordisInspectProviderManifest } from '../src/types.ts'

const manifest: CordisInspectProviderManifest = {
  id: 'Shared',
  description: 'Shared provider used by standing Profile generations.',
  methods: [{
    name: 'read',
    description: 'Read the active shared registration.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { generation: { type: 'string' } }, required: ['generation'] },
  }],
}

function provider(generation: string): HostCordisInspectProviderRegistration {
  return {
    manifest,
    query: () => Promise.resolve({ generation } as JsonValue),
  }
}

async function query(registry: CordisInspectRegistryService): Promise<JsonValue> {
  return await registry.query(
    'host',
    'Shared',
    'read',
    undefined,
    {} as Agent,
    new AbortController().signal,
  )
}

describe('Cordis Host inspect registry', () => {
  it('keeps exclusive registrations duplicate-safe', () => {
    const registry = new CordisInspectRegistryService(new Context())
    registry.register(provider('first'))

    expect(() => registry.register(provider('second')))
      .toThrow('Host Cordis inspect provider "Shared" is already registered')
  })

  it('shares compatible providers across standing generations and restores the survivor', async () => {
    const registry = new CordisInspectRegistryService(new Context())
    const disposeFirst = registry.share(provider('first'))
    const disposeSecond = registry.share(provider('second'))

    expect(registry.list().map(entry => entry.id)).toEqual(['Shared'])
    expect(await query(registry)).toEqual({ generation: 'second' })

    disposeSecond()
    expect(await query(registry)).toEqual({ generation: 'first' })

    disposeFirst()
    expect(registry.list()).toEqual([])
  })

  it('rejects incompatible shared manifests instead of masking a provider conflict', () => {
    const registry = new CordisInspectRegistryService(new Context())
    registry.share(provider('first'))

    expect(() => registry.share({
      ...provider('second'),
      manifest: { ...manifest, description: 'A different contract.' },
    })).toThrow('Host Cordis inspect provider "Shared" has an incompatible shared contract')
  })
})
