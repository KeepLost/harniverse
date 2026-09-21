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
})
