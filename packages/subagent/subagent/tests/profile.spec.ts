import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  assertResolvedChildProfile,
  foldSubagentDescriptor,
  childProfileToolFilter,
  isWorkspaceDescendant,
  parseResolvedChildProfile,
  resolveChildProfile,
  snapshotSubagentDescriptor,
  type ChildProfileGrant,
  type ChildProfileSpec,
  type ResolvedChildProfile,
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

  it('keeps an explicit child supervision mode in the immutable snapshot', () => {
    const profile = resolveChildProfile(spec({ supervisionMode: 'unsupervised' }), grant, 1)

    expect(profile.supervisionMode).toBe('unsupervised')
    expect(foldSubagentDescriptor([
      { type: 'subagent/descriptor', data: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'native', childProfile: profile }) },
    ] as unknown as SessionEvent[])?.childProfile).toEqual(profile)
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

describe('durable descriptor projection', () => {
  /** One descriptor event carrying an arbitrary persisted payload. */
  const stored = (data: unknown): SessionEvent[] =>
    [{ type: 'subagent/descriptor', data }] as unknown as SessionEvent[]

  it('omits every optional field a continuable descriptor does not declare', () => {
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'native',
      label: 'reviewer',
    })

    expect(descriptor).toEqual({ version: 3, mode: 'continuable', provider: 'native', label: 'reviewer' })
    for (const key of ['agentProvider', 'agentModel', 'persona', 'toolFilter', 'childProfile']) {
      expect(descriptor).not.toHaveProperty(key)
    }
  })

  it('carries every optional field a continuable descriptor declares', () => {
    const profile = resolveChildProfile(spec({ tools: ['read'] }), grant, 1)
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'native',
      label: 'reviewer',
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-v4-flash',
      persona: 'You review code.',
      toolFilter: { allow: ['read'] },
      childProfile: profile,
    })

    expect(descriptor).toMatchObject({
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-v4-flash',
      persona: 'You review code.',
      toolFilter: { allow: ['read'] },
      childProfile: profile,
    })
    // The durable projection round-trips every declared field.
    expect(foldSubagentDescriptor(stored(descriptor))).toEqual(descriptor)
  })

  it('reads back a continuable descriptor that declares no optional field', () => {
    const descriptor = { version: 3, mode: 'continuable', provider: 'native', label: 'reviewer' }

    expect(foldSubagentDescriptor(stored(descriptor))).toEqual(descriptor)
  })

  it('omits an absent label and child profile from a one-shot descriptor', () => {
    const descriptor = { version: 3, mode: 'one-shot', provider: 'native' }

    const folded = foldSubagentDescriptor(stored(descriptor))
    expect(folded).toEqual(descriptor)
    expect(folded).not.toHaveProperty('label')
    expect(folded).not.toHaveProperty('childProfile')
  })

  it('has no descriptor for a log that never recorded one', () => {
    expect(foldSubagentDescriptor([])).toBeUndefined()
    expect(foldSubagentDescriptor(stored({ version: 2, mode: 'one-shot', provider: 'native' }))).toBeUndefined()
  })
})

describe('resolved profile boundary validation', () => {
  const resolved = () => resolveChildProfile(spec(), grant, 1)

  /** One resolved profile with a field replaced, digest left stale. */
  const tampered = (overrides: Record<string, unknown>): ResolvedChildProfile =>
    ({ ...resolved(), ...overrides }) as ResolvedChildProfile

  /** One resolved profile with a field replaced and its digest recomputed. */
  function reblessed(overrides: Record<string, unknown>): ResolvedChildProfile {
    const candidate = { ...resolved(), ...overrides, digest: '' }
    const digest = createHash('sha256')
      .update(JSON.stringify(canonical(candidate)), 'utf8')
      .digest('hex')
    return { ...candidate, digest } as ResolvedChildProfile
  }

  /** The digest input the implementation canonicalizes: sorted keys, depth-first. */
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
    }
    return value
  }

  it('accepts a profile it resolved itself', () => {
    expect(() => assertResolvedChildProfile(resolved())).not.toThrow()
  })

  it.each([
    ['profileId', { profileId: '' }, /profileId must be a non-empty opaque id/],
    ['profileId with a leading separator', { profileId: '-bad' }, /profileId must be a non-empty opaque id/],
    ['harnessId', { harnessId: '' }, /harnessId must be a non-empty opaque id/],
    ['modelRouteId', { modelRouteId: '!' }, /modelRouteId must be a non-empty opaque id/],
  ])('refuses an unusable %s', (_label, overrides, message) => {
    expect(() => assertResolvedChildProfile(reblessed(overrides))).toThrow(message)
  })

  it('refuses a relative workspace cwd', () => {
    expect(() => assertResolvedChildProfile(reblessed({ workspaceCwd: 'relative/path' })))
      .toThrow(/workspaceCwd must be absolute/)
  })

  it.each([
    ['a fractional revision', { revision: 1.5 }],
    ['a negative revision', { revision: -1 }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => assertResolvedChildProfile(reblessed(overrides)))
      .toThrow(/revision must be a non-negative safe integer/)
  })

  it('refuses revision zero', () => {
    expect(() => assertResolvedChildProfile(reblessed({ revision: 0 })))
      .toThrow(/revision must be greater than zero/)
  })

  it.each([
    ['a malformed digest', { digest: 'not-a-digest' }],
    ['a well-formed digest over different contents', { digest: 'a'.repeat(64) }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => assertResolvedChildProfile(tampered(overrides)))
      .toThrow(/digest does not match its immutable contents/)
  })

  it('refuses a stale digest after a field changes', () => {
    // Same shape, one changed field, digest untouched.
    expect(() => assertResolvedChildProfile(tampered({ modelRouteId: 'other' })))
      .toThrow(/digest does not match its immutable contents/)
  })

  it.each(['tools', 'skills', 'mcpServerIds', 'childProfileIds'])('refuses a non-string %s member', (field) => {
    expect(() => assertResolvedChildProfile(reblessed({ [field]: [1] })))
      .toThrow(new RegExp(`${field} must be an array of strings`))
    expect(() => assertResolvedChildProfile(reblessed({ [field]: 'not-a-list' })))
      .toThrow(new RegExp(`${field} must be an array of strings`))
  })

  it.each([
    ['maxDepth', { maxDepth: -1 }],
    ['maxTokens', { maxTokens: 1.5 }],
    ['modelRoutePriority', { modelRoutePriority: -2 }],
    ['schedulerPriority', { schedulerPriority: Number.MAX_VALUE }],
  ])('refuses an unusable %s', (field, overrides) => {
    expect(() => assertResolvedChildProfile(reblessed(overrides)))
      .toThrow(new RegExp(`${field} must be a non-negative safe integer`))
  })

  it('refuses an unknown supervision mode', () => {
    expect(() => assertResolvedChildProfile(reblessed({ supervisionMode: 'autopilot' })))
      .toThrow(/supervisionMode must be "supervised" or "unsupervised"/)
  })
})

describe('persisted profile parsing', () => {
  const stored = () => JSON.parse(JSON.stringify(resolveChildProfile(spec(), grant, 1))) as Record<string, unknown>

  it('round-trips a stored profile into a frozen value', () => {
    const parsed = parseResolvedChildProfile(stored())

    expect(parsed).toEqual(resolveChildProfile(spec(), grant, 1))
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.tools)).toBe(true)
  })

  it.each([
    ['a non-object', 'text'],
    ['null', null],
    ['an array', []],
  ])('refuses %s document', (_label, value) => {
    expect(() => parseResolvedChildProfile(value)).toThrow(/must be an object/)
  })

  it('refuses an unknown field', () => {
    expect(() => parseResolvedChildProfile({ ...stored(), surprise: 1 }))
      .toThrow(/unknown field "surprise"/)
  })

  it.each(['profileId', 'digest', 'harnessId', 'modelRouteId', 'workspaceCwd'])(
    'refuses an unusable %s',
    (key) => {
      expect(() => parseResolvedChildProfile({ ...stored(), [key]: '' }))
        .toThrow(new RegExp(`${key} must be a non-empty string`))
      expect(() => parseResolvedChildProfile({ ...stored(), [key]: 7 }))
        .toThrow(new RegExp(`${key} must be a non-empty string`))
    },
  )

  it.each(['tools', 'skills', 'mcpServerIds', 'childProfileIds'])('refuses an unusable %s list', (key) => {
    expect(() => parseResolvedChildProfile({ ...stored(), [key]: 'read' }))
      .toThrow(new RegExp(`${key} must be an array of strings`))
    expect(() => parseResolvedChildProfile({ ...stored(), [key]: [1] }))
      .toThrow(new RegExp(`${key} must be an array of strings`))
  })

  it('round-trips a stored profile carrying no granted skills', () => {
    const resolved = resolveChildProfile(spec({ skills: [] }), grant, 1)
    const parsed = parseResolvedChildProfile(JSON.parse(JSON.stringify(resolved)))

    expect(parsed.skills).toEqual([])
    expect(parsed).toEqual(resolved)
  })

  it.each(['maxDepth', 'maxTokens', 'modelRoutePriority', 'schedulerPriority'])(
    'refuses a non-numeric %s',
    (key) => {
      expect(() => parseResolvedChildProfile({ ...stored(), [key]: '4' }))
        .toThrow(new RegExp(`${key} must be a number`))
    },
  )

  it('refuses a non-numeric revision', () => {
    expect(() => parseResolvedChildProfile({ ...stored(), revision: '1' }))
      .toThrow(/revision must be a number/)
  })

  it('refuses an unknown stored supervision mode', () => {
    expect(() => parseResolvedChildProfile({ ...stored(), supervisionMode: 'autopilot' }))
      .toThrow(/supervisionMode must be "supervised" or "unsupervised"/)
  })

  it('carries the optional numeric fields through when present', () => {
    const resolved = resolveChildProfile(spec({ maxDepth: 2, maxTokens: 500 }), grant, 1)
    const parsed = parseResolvedChildProfile(JSON.parse(JSON.stringify(resolved)))

    expect(parsed).toMatchObject({ maxDepth: 2, maxTokens: 500 })
    expect(parsed).toEqual(resolved)
  })
})

describe('grant ceilings and workspace derivation', () => {
  it('refuses a parent cwd outside the workspace root', () => {
    expect(() => resolveChildProfile(spec(), { ...grant, parentWorkspaceCwd: '/elsewhere' }, 1))
      .toThrow(/parent workspace cwd must be inside the workspace root/)
  })

  it.each([
    ['maxDepth', { maxDepth: 5 }, /maxDepth exceeds the parent grant/],
    ['maxTokens', { maxTokens: 20_000 }, /maxTokens exceeds the parent grant/],
  ])('refuses a %s above the parent grant', (_label, overrides, message) => {
    expect(() => resolveChildProfile(spec(overrides), grant, 1)).toThrow(message)
  })

  it.each([
    ['maxDepth', { maxDepth: 2 }],
    ['maxTokens', { maxTokens: 500 }],
  ])('prefers an explicit %s within the ceiling', (field, overrides) => {
    expect(resolveChildProfile(spec(overrides), grant, 1))
      .toMatchObject(overrides)
    // The unspecified sibling still inherits its granted ceiling.
    expect(resolveChildProfile(spec(overrides), grant, 1)[field === 'maxDepth' ? 'maxTokens' : 'maxDepth'])
      .toBe(field === 'maxDepth' ? grant.maxTokens : grant.maxDepth)
  })

  it('omits both bounds when neither the spec nor the grant sets them', () => {
    const { maxDepth: _depth, maxTokens: _tokens, ...unbounded } = grant
    const profile = resolveChildProfile(spec(), unbounded, 1)

    expect('maxDepth' in profile).toBe(false)
    expect('maxTokens' in profile).toBe(false)
  })

  it('accepts a tool filter requesting only granted tools', () => {
    const profile = resolveChildProfile(spec({ tools: ['read', 'write'] }), grant, 1)

    expect(childProfileToolFilter(profile, { allow: ['write', 'read', 'read'] }))
      .toEqual({ allow: ['read', 'write'] })
  })
})

describe('resolution boundary refusals', () => {
  it('refuses revision zero', () => {
    expect(() => resolveChildProfile(spec(), grant, 0))
      .toThrow(/child profile revision must be greater than zero/)
  })

  it('refuses an unknown supervision mode', () => {
    expect(() => resolveChildProfile(spec({ supervisionMode: 'autopilot' as never }), grant, 1))
      .toThrow(/supervisionMode must be "supervised" or "unsupervised"/)
  })

  it('carries the optional priorities and supervision mode when the spec sets them', () => {
    const profile = resolveChildProfile(
      spec({ modelRoutePriority: 3, schedulerPriority: 7, supervisionMode: 'unsupervised' }),
      grant,
      1,
    )

    expect(profile).toMatchObject({ modelRoutePriority: 3, schedulerPriority: 7, supervisionMode: 'unsupervised' })
    expect(parseResolvedChildProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile)
  })

  it('omits the optional priorities and supervision mode when the spec omits them', () => {
    const profile = resolveChildProfile(spec(), grant, 1)

    expect('modelRoutePriority' in profile).toBe(false)
    expect('schedulerPriority' in profile).toBe(false)
    expect('supervisionMode' in profile).toBe(false)
  })
})

describe('persisted profile without bounds', () => {
  it('round-trips a stored profile that carries neither bound', () => {
    const { maxDepth: _depth, maxTokens: _tokens, ...unbounded } = grant
    const resolved = resolveChildProfile(spec(), unbounded, 1)
    const parsed = parseResolvedChildProfile(JSON.parse(JSON.stringify(resolved)))

    expect('maxDepth' in parsed).toBe(false)
    expect('maxTokens' in parsed).toBe(false)
    expect(parsed).toEqual(resolved)
  })
})
