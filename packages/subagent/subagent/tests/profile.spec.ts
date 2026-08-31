import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  foldSubagentDescriptor,
  childProfileToolFilter,
  isWorkspaceDescendant,
  resolveChildProfile,
  snapshotSubagentDescriptor,
  type ChildProfileGrant,
  type ChildProfileSpec,
} from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const grant: ChildProfileGrant = {
  harnessIds: ['native', 'sdk'],
  modelRouteIds: ['fast', 'safe'],
  tools: ['read', 'write'],
  skills: ['review'],
  mcpServerIds: ['docs'],
  childProfileIds: ['reviewer'],
  workspaceRoot: '/repo',
  parentWorkspaceCwd: '/repo/packages',
  maxDepth: 4,
  maxTokens: 10_000,
}

function spec(overrides: Partial<ChildProfileSpec> = {}): ChildProfileSpec {
  return { profileId: 'reviewer', harnessId: 'native', modelRouteId: 'safe', ...overrides }
}

describe('Child Profile resolution', () => {
  it('intersects requested capabilities and freezes a stable detached snapshot', () => {
    const profile = resolveChildProfile(spec({ tools: ['read'], workspaceCwd: 'service' }), grant, 2)
    expect(profile).toMatchObject({
      profileId: 'reviewer',
      revision: 2,
      harnessId: 'native',
      modelRouteId: 'safe',
      tools: ['read'],
      skills: ['review'],
      workspaceCwd: resolve(grant.parentWorkspaceCwd, 'service'),
      maxDepth: 4,
      maxTokens: 10_000,
    })
    expect(profile.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.tools)).toBe(true)
    expect(resolveChildProfile(spec({ tools: ['read'], workspaceCwd: 'service' }), grant, 2).digest).toBe(profile.digest)
  })

  it('rejects every requested capability outside the parent grant instead of clipping it', () => {
    expect(() => resolveChildProfile(spec({ tools: ['read', 'shell'] }), grant, 1)).toThrow('outside the parent grant')
    expect(() => resolveChildProfile(spec({ harnessId: 'shell' }), grant, 1)).toThrow('harnessId is not granted')
    expect(() => resolveChildProfile(spec({ modelRouteId: 'private' }), grant, 1)).toThrow('modelRouteId is not granted')
    expect(() => resolveChildProfile(spec({ childProfileIds: ['admin'] }), grant, 1)).toThrow('outside the parent grant')
  })

  it('enforces limits and workspace descendant boundaries', () => {
    expect(() => resolveChildProfile(spec({ maxDepth: 5 }), grant, 1)).toThrow('maxDepth exceeds')
    expect(() => resolveChildProfile(spec({ workspaceCwd: '../outside' }), grant, 1)).toThrow('remain inside')
    expect(() => resolveChildProfile(spec({ workspaceCwd: '/tmp' }), grant, 1)).toThrow('must be relative')
    expect(() => resolveChildProfile(spec({ workspaceCwd: 'service/../../outside' }), grant, 1)).toThrow('remain inside')
  })

  it('does not confuse a shared path prefix with a descendant', () => {
    expect(isWorkspaceDescendant('/repo', '/repo/packages')).toBe(true)
    expect(isWorkspaceDescendant('/repo', '/repo-other')).toBe(false)
    expect(isWorkspaceDescendant('/repo', '/repo')).toBe(true)
  })

  it('round-trips the resolved snapshot through the durable descriptor', () => {
    const profile = resolveChildProfile(spec({ tools: ['read'] }), grant, 3)
    const descriptor = snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'native', childProfile: profile })
    const event = { type: 'subagent/descriptor', data: descriptor } as unknown as SessionEvent<'subagent/descriptor'>
    expect(foldSubagentDescriptor([event])?.childProfile).toEqual(profile)
  })

  it('never lets a per-start tool filter widen the resolved profile', () => {
    const profile = resolveChildProfile(spec({ tools: ['read'] }), grant, 1)
    expect(childProfileToolFilter(profile, { deny: ['read'] })).toEqual({ allow: ['read'], deny: ['read'] })
    expect(() => childProfileToolFilter(profile, { allow: ['write'] })).toThrow('outside child profile')
  })
})
