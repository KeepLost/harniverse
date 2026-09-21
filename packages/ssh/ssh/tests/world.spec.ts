/** Captured world construction: profile rules, inventory-derived capabilities, and digest-verified freezing. */
import { describe, expect, it } from 'vitest'
import { capturedProfileSchema, describeExecutionWorld, parseWorldDescription } from '../src/world.ts'

describe('captured SSH world', () => {
  it('rejects local Cordis and retains distinct immutable revisions', () => {
    expect(() => capturedProfileSchema.parse({ id: 'cordis', revision: '7', mcp: {}, skills: [], hooks: [] })).toThrow('Host-local')
    const world = describeExecutionWorld('/remote/work', 'machine-2', { id: 'ssh', revision: 'profile-7', mcp: {}, skills: [], hooks: [] }, { mcp: [], skills: [], hooks: [] })
    expect(world.descriptor.revision).toBe('machine-2')
    expect(world.profile.revision).toBe('profile-7')
    expect(world.descriptor.presets).toEqual(['ssh'])
    expect(Object.isFrozen(world.profile.mcp)).toBe(true)
    expect(() => parseWorldDescription({ ...world, descriptor: { ...world.descriptor, workspaceRoot: '/host/local' } })).toThrow('digest mismatch')
  })

  it('derives machine capabilities from the discovered inventory', () => {
    const world = describeExecutionWorld('/remote/work', 'machine-3', { id: 'ssh', revision: 'profile-7', mcp: {}, skills: [], hooks: [] }, {
      mcp: [
        { serverName: 'remote', selected: true, instructions: '', tools: [], resources: [], templates: [] },
        { serverName: 'off', selected: false, instructions: '', tools: [], resources: [], templates: [] },
      ],
      skills: [{ name: 'deploy', description: 'Remote deploy skill', path: '/skills/deploy', selected: true }],
      hooks: [],
    })
    const byId = new Map(world.descriptor.capabilities.map(capability => [capability.id, capability]))
    expect(byId.get(`mcp-server:${Buffer.from('remote').toString('hex')}`)).toMatchObject({ kind: 'mcp-server', name: 'remote', available: true })
    expect(byId.get(`mcp-server:${Buffer.from('off').toString('hex')}`)).toMatchObject({ available: false, defaultLoaded: false })
    expect(byId.get('remote-skill:deploy')).toMatchObject({ kind: 'skill', name: 'deploy', defaultLoaded: true })
    expect(byId.get('remote-filesystem')).toMatchObject({ kind: 'tool', name: 'filesystem' })
  })
})
