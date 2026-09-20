/** Machine-owned world inventory: description, Profile restriction and the world.describe RPC. */
import { describe, expect, it } from 'vitest'
import type { CapabilityOverride } from '@deepseek-ai/dsh-capabilities'
import { buildExecutionWorldDescriptor } from '@deepseek-ai/dsh-execution-descriptor'
import { z } from 'zod'
import {
  describeExecutionWorld,
  deriveWorldId,
  parseWorldDescription,
  restrictWorldToProfile,
  type MachineConfigSnapshot,
} from '../src/world.ts'
import { createHelperHarness as helper } from './fixtures/helper.ts'

const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const inventory: MachineConfigSnapshot = {
  mcpServers: [
    { id: 'srv-filesystem', serverName: 'fs', transport: 'stdio', enabled: true, envKeys: ['DEEPSEEK_API_KEY', 'MCP_LOG_LEVEL'] },
    { id: 'srv-disabled', serverName: 'off', transport: 'streamable-http', enabled: false, envKeys: ['DEEPSEEK_API_KEY'] },
  ],
  skills: [{ id: 'sk-deploy', name: 'deploy', source: 'user-dsh' }],
  hooks: [{ family: 'claude-code', source: '/home/user/.claude/settings.json', hooks: 4 }],
}

describe('world description', () => {
  it('builds a digest-verified descriptor with truthful rows from machine-owned inputs', () => {
    const world = describeExecutionWorld({ worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '17', inventory })
    expect(parseWorldDescription({ descriptor: { ...world.descriptor }, hooks: world.hooks.map(row => ({ ...row })) })).toEqual(world)
    expect(world.descriptor.transport).toBe('ssh')
    expect(world.descriptor.configOwner).toBe('machine')
    expect(world.descriptor.credentialRefs).toEqual(['DEEPSEEK_API_KEY', 'MCP_LOG_LEVEL'])
    const byId = new Map(world.descriptor.capabilities.map(row => [row.id, row]))
    expect([...byId.keys()]).toEqual(['remote-fs', 'remote-subprocess', 'remote-sandbox', 'srv-filesystem', 'srv-disabled', 'sk-deploy'])
    expect(byId.get('remote-fs')).toMatchObject({ kind: 'tool', assembleable: true, available: true, defaultLoaded: true, manageable: false })
    expect(byId.get('srv-filesystem')).toMatchObject({ kind: 'mcp-server', available: true, defaultLoaded: true, manageable: false })
    expect(byId.get('srv-disabled')).toMatchObject({ kind: 'mcp-server', available: false, defaultLoaded: false })
    expect(byId.get('sk-deploy')).toMatchObject({ kind: 'skill', provenance: 'external', manageable: false })
    expect(world.hooks).toEqual([{ family: 'claude-code', source: '/home/user/.claude/settings.json', hooks: 4 }])
  })

  it('omits tool rows for providers the helper did not mount and reports the empty inventory truthfully', () => {
    const world = describeExecutionWorld({
      worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '1',
      providers: { filesystem: true, subprocess: false, sandbox: true },
    })
    expect(world.descriptor.capabilities.map(row => row.id)).toEqual(['remote-fs', 'remote-sandbox'])
    expect(world.descriptor.credentialRefs).toEqual([])
    expect(world.hooks).toEqual([])
  })

  it('refuses local-only presets on the machine side exactly as the host parser does', () => {
    expect(() => describeExecutionWorld({ worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '1', presets: ['cordis'] }))
      .toThrow(/Host-local by design/)
    expect(describeExecutionWorld({ worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '1', presets: ['code-run'] }).descriptor.presets)
      .toEqual(['code-run'])
  })

  it('derives pattern-valid, stable world identities from host name and workspace', () => {
    const worldId = deriveWorldId('Box.Example-01..COM', '/srv/work')
    expect(worldId).toMatch(WORLD_ID_PATTERN)
    expect(worldId).toBe(deriveWorldId('BOX.example-01..com', '/srv/work'))
    expect(worldId).not.toBe(deriveWorldId('box.example-01.com', '/srv/other'))
    expect(deriveWorldId('', '/srv/work')).toMatch(/^ssh-[0-9a-f]{12}$/u)
    expect(deriveWorldId('???', '/srv/work')).toBe(deriveWorldId('', '/srv/work'))
    expect(deriveWorldId('', '/srv/work')).toMatch(WORLD_ID_PATTERN)
  })

  it('rejects a tampered descriptor through digest verification on the host side', () => {
    const world = describeExecutionWorld({ worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '17', inventory })
    const tampered = { ...world.descriptor, revision: '18' }
    expect(() => parseWorldDescription({ descriptor: tampered, hooks: [] })).toThrow(/digest mismatch/)
    expect(() => parseWorldDescription({ descriptor: world.descriptor, hooks: [{ family: 'codex' as const, source: 'x', hooks: -1 }] })).toThrow()
    expect(() => parseWorldDescription({ descriptor: world.descriptor })).toThrow()
  })
})

describe('Profile restriction of a described world', () => {
  const world = describeExecutionWorld({ worldId: 'box-abc123', workspaceRoot: '/srv/work', revision: '17', inventory })
  const { digest: reportedDigest, ...covered } = world.descriptor
  void reportedDigest
  const withMembers = buildExecutionWorldDescriptor({
    ...covered,
    capabilities: [
      ...world.descriptor.capabilities.filter(row => row.id !== 'srv-filesystem'),
      {
        id: 'srv-filesystem', kind: 'mcp-server', name: 'fs', description: 'machine MCP server', provenance: 'external',
        assembleable: false, available: true, defaultLoaded: true, manageable: false, requires: [],
        members: [
          { id: 'read_file', kind: 'mcp-tool', name: 'read_file', description: 'read', defaultVisible: true, available: true, requires: [] },
          { id: 'write_file', kind: 'mcp-tool', name: 'write_file', description: 'write', defaultVisible: true, available: true, requires: [] },
        ],
      },
    ],
  })

  it('assembles everything reported when the Profile pins nothing', () => {
    const restricted = restrictWorldToProfile(world.descriptor, {})
    expect(restricted.effective.map(row => row.id)).toEqual(world.descriptor.capabilities.map(row => row.id))
    expect(restricted.excluded).toEqual([])
    expect(restricted.unresolved).toEqual([])
  })

  it('excludes unloaded capabilities with a reason and lists host-local pins as unresolved', () => {
    const profile: Readonly<Record<string, CapabilityOverride>> = {
      'srv-disabled': { selection: 'unload' },
      'sk-deploy': { selection: 'unload' },
      cordis: { selection: 'load' },
    }
    const restricted = restrictWorldToProfile(world.descriptor, profile)
    expect(restricted.excluded).toEqual([
      { id: 'srv-disabled', reason: 'unloaded-by-profile' },
      { id: 'sk-deploy', reason: 'unloaded-by-profile' },
    ])
    expect(restricted.unresolved).toEqual(['cordis'])
    expect(restricted.effective.map(row => row.id)).not.toContain('srv-disabled')
  })

  it('filters members to the Profile selection and excludes capabilities left without members', () => {
    const restricted = restrictWorldToProfile(withMembers, {
      'srv-filesystem': { members: ['read_file'] },
      'sk-deploy': { members: ['absent-member'] },
    })
    const server = restricted.effective.find(row => row.id === 'srv-filesystem')
    expect(server?.members?.map(member => member.id)).toEqual(['read_file'])
    expect(restricted.excluded).toEqual([{ id: 'sk-deploy', reason: 'members-excluded' }])
    expect(restricted.unresolved).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('world.describe over the helper RPC', () => {
  it('reports the default helper as the truthful empty machine inventory over its negotiated workspace', async () => {
    const test = await helper()
    try {
      const response = await test.client.request('world.describe', {}, z.unknown())
      const world = parseWorldDescription(response)
      expect(world.descriptor.workspaceRoot).toBe(test.root)
      expect(world.descriptor.transport).toBe('ssh')
      expect(world.descriptor.worldId).toMatch(WORLD_ID_PATTERN)
      expect(world.descriptor.capabilities.map(row => row.id)).toEqual(['remote-fs', 'remote-subprocess', 'remote-sandbox'])
      expect(world.descriptor.credentialRefs).toEqual([])
      expect(world.hooks).toEqual([])
      const again = parseWorldDescription(await test.client.request('world.describe', {}, z.unknown()))
      expect(again.descriptor).toEqual(world.descriptor)
    } finally { await test.close() }
  })

  it('carries the machine composition inventory through to the host-verified description', async () => {
    const test = await helper(true, 30_000, {
      worldId: 'inventory-box',
      presets: ['code-run'],
      inventory: {
        snapshot: async () => inventory,
      },
    })
    try {
      const world = parseWorldDescription(await test.client.request('world.describe', {}, z.unknown()))
      expect(world.descriptor.worldId).toBe('inventory-box')
      expect(world.descriptor.presets).toEqual(['code-run'])
      expect(world.descriptor.capabilities.map(row => row.id)).toContain('srv-filesystem')
      expect(world.descriptor.credentialRefs).toEqual(['DEEPSEEK_API_KEY', 'MCP_LOG_LEVEL'])
      expect(world.hooks).toEqual([{ family: 'claude-code', source: '/home/user/.claude/settings.json', hooks: 4 }])
    } finally { await test.close() }
  })
})
