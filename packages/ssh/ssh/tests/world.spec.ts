/** Captured world construction: profile rules, inventory-derived capabilities, and digest-verified freezing. */
import { describe, expect, it } from 'vitest'
import { capturedProfileSchema, describeExecutionWorld, parseWorldDescription } from '../src/world.ts'

const emptyProfile = { id: 'ssh', revision: 'profile-7', mcp: {}, skills: [], hooks: [] }

describe('captured SSH world', () => {
  it('rejects local Cordis and retains distinct immutable revisions', () => {
    expect(() => capturedProfileSchema.parse({ id: 'cordis', revision: '7', mcp: {}, skills: [], hooks: [] })).toThrow('Host-local')
    const world = describeExecutionWorld('/remote/work', 'machine-2', emptyProfile, { mcp: [], skills: [], hooks: [] })
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

describe('machine inventory name constraints', () => {
  // The machine's inventory is untrusted wire input whose names register into
  // the Host tool table and skill registry, so a hostile machine cannot spoof,
  // flood, or shadow local entries through them.
  const withToolName = (name: string) => ({ mcp: [{ serverName: 'remote', selected: true, instructions: '', tools: [{ name, rawName: name, description: '', inputSchema: {} }], resources: [], templates: [] }], skills: [], hooks: [] })
  const withSkillName = (name: string) => ({ mcp: [], skills: [{ name, description: '', path: `/skills/${name}`, selected: true }], hooks: [] })
  const withServerName = (name: string) => ({ mcp: [{ serverName: name, selected: true, instructions: '', tools: [], resources: [], templates: [] }], skills: [], hooks: [] })
  const attempt = (inventory: object): (() => void) => () => {
    parseWorldDescription(describeExecutionWorld('/remote/work', 'machine-6', emptyProfile, inventory as never))
  }

  it('accepts bounded identifier-shaped names', () => {
    expect(attempt(withToolName('read_file-v2'))).not.toThrow()
    expect(attempt(withSkillName('deploy.skill'))).not.toThrow()
    expect(attempt(withServerName('ci-builder'))).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['over length', 'x'.repeat(65)],
    ['control characters', 'read\nfile'],
    ['leading separator', '-shadow'],
  ])('rejects a tool name that is %s', (_label, name) => {
    expect(attempt(withToolName(name))).toThrow(/name/)
  })

  it('rejects the reserved PTC transport tool name', () => {
    expect(attempt(withToolName('run_code'))).toThrow('run_code')
  })

  it('rejects hostile skill and server names', () => {
    expect(attempt(withSkillName('x'.repeat(65)))).toThrow(/name/)
    expect(attempt(withServerName('spoof\nremote'))).toThrow(/serverName/)
  })
})
