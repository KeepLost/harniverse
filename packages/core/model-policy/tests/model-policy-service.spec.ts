import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import ModelPolicyService, {
  MODEL_PROFILES_SETTINGS_NAMESPACE,
  UNRESTRICTED_MODEL_PROFILE_ID,
  ModelTargetNotAllowedError,
  effectiveModelProfile,
} from '../src/index.ts'
import type { Config, ModelProfile, ModelRoute } from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const focusedProfile: ModelProfile = {
  name: 'Focused',
  models: [{ provider: 'deepseek', model: 'chat' }],
  routes: ['fallback'],
  defaultTarget: { kind: 'route', route: 'fallback' },
}

const fallbackRoute: ModelRoute = {
  targets: [
    { provider: 'deepseek', model: 'chat' },
    { provider: 'backup', model: 'chat' },
  ],
}

async function boot(config?: Config): Promise<{ ctx: Context; policy: ModelPolicyService }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ModelPolicyService, config ?? {
    profiles: { focused: structuredClone(focusedProfile) },
    routes: { fallback: structuredClone(fallbackRoute) },
  })
  return { ctx, policy: ctx.modelPolicy }
}

describe('ModelPolicyService surface', () => {
  it('composes with built-in defaults when configured bare', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(ModelPolicyService)
    const policy = ctx.modelPolicy
    expect(policy.defaultProfileId()).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
    expect(policy.listProfiles()).toEqual([{
      id: UNRESTRICTED_MODEL_PROFILE_ID,
      name: 'Unrestricted',
      description: 'All registered concrete models and routes are allowed.',
      unrestricted: true,
    }])
    expect(policy.listRoutes()).toEqual([])
    const session = ctx.sessions.create()
    expect(policy.initialize(session).id).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
    expect(policy.snapshotFor(UNRESTRICTED_MODEL_PROFILE_ID).revision)
      .toBe(policy.snapshotFor(UNRESTRICTED_MODEL_PROFILE_ID).revision)
    await ctx.fiber.dispose()
  })

  it('serves discovery from the composition entry when constructed without a settings service', () => {
    const ctx = new Context()
    const policy = new ModelPolicyService(ctx)
    expect(policy.defaultProfileId()).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
    expect(policy.listProfiles()).toHaveLength(1)
    expect(policy.listRoutes()).toEqual([])
    expect(policy.snapshotFor(UNRESTRICTED_MODEL_PROFILE_ID).id).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
  })

  it('rejects and persists targets through the profile guard', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    policy.initialize(session, 'focused')
    expect(policy.targetOf(session)).toEqual({ kind: 'route', route: 'fallback' })
    const denial = (): void => { policy.setTarget(session, { kind: 'route', route: 'other' }) }
    expect(denial).toThrow(ModelTargetNotAllowedError)
    expect(denial).toThrow('model target is not allowed by profile "focused"')
    const rejected = new ModelTargetNotAllowedError('focused')
    expect(rejected.code).toBe('MODEL_TARGET_NOT_ALLOWED')
    policy.setTarget(session, { kind: 'model', selection: { provider: 'deepseek', model: 'chat' } })
    expect(policy.targetOf(session)).toEqual({ kind: 'model', selection: { provider: 'deepseek', model: 'chat' } })
    expect(session.events.at(-1)?.type).toBe('model/target')
    await ctx.fiber.dispose()
  })

  it('lists configured profiles with optional display fields and hides the built-in id', async () => {
    const { ctx, policy } = await boot({
      profiles: {
        focused: structuredClone(focusedProfile),
        bare: {
          models: [],
          routes: [],
          description: 'Only named by id',
          defaultTarget: { kind: 'model', selection: { provider: 'deepseek', model: 'chat' } },
        },
        unrestricted: {
          models: [],
          routes: [],
          defaultTarget: { kind: 'model', selection: { provider: 'deepseek', model: 'chat' } },
        },
      },
      routes: { fallback: structuredClone(fallbackRoute) },
    })
    const listed = policy.listProfiles()
    expect(listed.map(profile => profile.id)).toEqual([UNRESTRICTED_MODEL_PROFILE_ID, 'focused', 'bare'])
    const focused = listed.find(profile => profile.id === 'focused')
    const bare = listed.find(profile => profile.id === 'bare')
    expect(focused?.name).toBe('Focused')
    expect('description' in (focused ?? {})).toBe(false)
    expect(bare?.name).toBe('bare')
    expect(bare?.description).toBe('Only named by id')
    expect(policy.snapshotFor('bare').name).toBe('bare')
    await ctx.fiber.dispose()
  })

  it('lists configured routes with optional names and detached efforts', async () => {
    const { ctx, policy } = await boot({
      profiles: { focused: structuredClone(focusedProfile) },
      routes: {
        fallback: structuredClone(fallbackRoute),
        named: {
          name: 'Named route',
          targets: [{ provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }],
        },
      },
    })
    const listed = policy.listRoutes()
    expect(listed.map(route => route.id)).toEqual(['fallback', 'named'])
    expect('name' in (listed[0] ?? {})).toBe(false)
    expect(listed[1]).toMatchObject({
      id: 'named',
      name: 'Named route',
      configured: true,
      targets: [{ provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }],
    })
    await ctx.fiber.dispose()
  })

  it('resolves the default profile from composition and live settings', async () => {
    const { ctx, policy } = await boot({ defaultProfile: 'focused' })
    expect(policy.defaultProfileId()).toBe('focused')
    await ctx.settings.replace(MODEL_PROFILES_SETTINGS_NAMESPACE, {
      defaultProfile: '',
      profiles: { focused: structuredClone(focusedProfile) },
    })
    expect(policy.defaultProfileId()).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
    await ctx.settings.replace(MODEL_PROFILES_SETTINGS_NAMESPACE, {
      defaultProfile: 'focused',
      profiles: { focused: structuredClone(focusedProfile) },
    })
    expect(policy.defaultProfileId()).toBe('focused')
    await ctx.fiber.dispose()
  })

  it('rejects snapshots for unknown profiles and dangling route references', async () => {
    const { ctx, policy } = await boot({
      profiles: {
        focused: structuredClone(focusedProfile),
        broken: {
          models: [],
          routes: ['ghost'],
          defaultTarget: { kind: 'route', route: 'ghost' },
        },
      },
      routes: { fallback: structuredClone(fallbackRoute) },
    })
    expect(() => policy.snapshotFor('ghost')).toThrow('unknown model profile "ghost"')
    expect(() => policy.snapshotFor('broken')).toThrow('model profile "broken" references unknown route "ghost"')
    await ctx.fiber.dispose()
  })

  it('captures route names and profile descriptions into snapshots', async () => {
    const { ctx, policy } = await boot({
      profiles: {
        focused: {
          ...structuredClone(focusedProfile),
          description: 'Keeps the session on the fallback chain',
        },
      },
      routes: {
        fallback: { name: 'Fallback chain', targets: structuredClone(fallbackRoute.targets) },
      },
    })
    const snapshot = policy.snapshotFor('focused')
    expect(snapshot.description).toBe('Keeps the session on the fallback chain')
    expect(snapshot.routeSnapshots.fallback).toEqual({
      id: 'fallback',
      name: 'Fallback chain',
      targets: structuredClone(fallbackRoute.targets),
    })
    await ctx.fiber.dispose()
  })

  it('returns the existing snapshot when a session is initialized again', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    const first = policy.initialize(session, 'focused')
    expect(policy.initialize(session, 'unrestricted')).toEqual(first)
    expect(policy.initialize(session, 'unrestricted')).toBe(effectiveModelProfile(session.events))
    expect(session.events.filter(event => event.type === 'model/profile')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('switches profiles and only selects a default target when one exists', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    const snapshot = policy.setProfile(session, 'focused')
    expect(snapshot.id).toBe('focused')
    expect(session.events.filter(event => event.type === 'model/target')).toHaveLength(1)
    const legacy = ctx.sessions.create()
    policy.setProfile(legacy, UNRESTRICTED_MODEL_PROFILE_ID)
    expect(legacy.events.filter(event => event.type === 'model/profile')).toHaveLength(1)
    expect(legacy.events.filter(event => event.type === 'model/target')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('authorizes concrete requests including route efforts', async () => {
    const { ctx, policy } = await boot({
      profiles: { focused: structuredClone(focusedProfile) },
      routes: {
        fallback: {
          targets: [
            { provider: 'deepseek', model: 'chat' },
            { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
          ],
        },
      },
    })
    const session = ctx.sessions.create()
    policy.initialize(session, 'focused')
    const snapshot = policy.profileOf(session)
    expect(policy.allowsConcrete(snapshot, { provider: 'any', model: 'model' })).toBe(false)
    expect(policy.allowsConcrete(snapshot, { provider: 'deepseek', model: 'chat' })).toBe(true)
    expect(policy.allowsConcrete(snapshot, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })).toBe(true)
    expect(policy.allowsConcrete(snapshot, { provider: 'deepseek', model: 'reasoner' })).toBe(false)
    expect(policy.allowsConcrete(snapshot, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'low' })).toBe(false)
    const legacy = ctx.sessions.create()
    const unrestricted = policy.profileOf(legacy)
    expect(policy.allowsConcrete(unrestricted, { provider: 'any', model: 'model' })).toBe(true)
    await ctx.fiber.dispose()
  })

  it('resolves concrete targets from live and snapshotted routes', async () => {
    const { ctx, policy } = await boot()
    const restricted = ctx.sessions.create()
    policy.initialize(restricted, 'focused')
    const legacy = ctx.sessions.create()
    policy.profileOf(legacy)
    expect(policy.targetOf(legacy)).toBeUndefined()
    expect(policy.concreteTarget(restricted, { kind: 'model', selection: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } }))
      .toEqual({ provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
    expect(policy.concreteTarget(legacy, { kind: 'route', route: 'fallback' }))
      .toEqual({ provider: 'deepseek', model: 'chat' })
    expect(policy.concreteTarget(legacy, { kind: 'route', route: 'ghost' })).toBeUndefined()
    expect(policy.targetsFor(restricted, { kind: 'model', selection: { provider: 'deepseek', model: 'chat' } }))
      .toEqual([{ provider: 'deepseek', model: 'chat' }])
    expect(policy.targetsFor(restricted, { kind: 'route', route: 'fallback' })).toEqual(fallbackRoute.targets)
    expect(policy.targetsFor(legacy, { kind: 'route', route: 'fallback' })).toEqual(fallbackRoute.targets)
    expect(policy.targetsFor(legacy, { kind: 'route', route: 'ghost' })).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resolves concrete targets for candidate snapshots', async () => {
    const { ctx, policy } = await boot()
    const unrestricted = policy.snapshotFor(UNRESTRICTED_MODEL_PROFILE_ID)
    const restricted = policy.snapshotFor('focused')
    expect(policy.concreteTargetForSnapshot(restricted, { kind: 'model', selection: { provider: 'deepseek', model: 'chat' } }))
      .toEqual({ provider: 'deepseek', model: 'chat' })
    expect(policy.concreteTargetForSnapshot(unrestricted, { kind: 'route', route: 'fallback' }))
      .toEqual({ provider: 'deepseek', model: 'chat' })
    expect(policy.concreteTargetForSnapshot(restricted, { kind: 'route', route: 'fallback' }))
      .toEqual({ provider: 'deepseek', model: 'chat' })
    expect(policy.concreteTargetForSnapshot(restricted, { kind: 'route', route: 'ghost' })).toBeUndefined()
    expect(policy.concreteTargetForSnapshot(unrestricted, { kind: 'route', route: 'ghost' })).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('saves complete profile and route settings documents', async () => {
    const { ctx, policy } = await boot()
    await policy.saveProfiles({
      defaultProfile: 'saved',
      profiles: {
        saved: {
          models: [{ provider: 'deepseek', model: 'chat' }],
          routes: ['chain'],
          defaultTarget: { kind: 'route', route: 'chain' },
        },
      },
    })
    expect(policy.defaultProfileId()).toBe('saved')
    expect(policy.listProfiles().map(profile => profile.id)).toEqual([UNRESTRICTED_MODEL_PROFILE_ID, 'focused', 'saved'])
    await policy.saveRoutes({ routes: { chain: { targets: [{ provider: 'deepseek', model: 'chat' }] } } })
    expect(policy.listRoutes().map(route => route.id)).toEqual(['fallback', 'chain'])
    await ctx.fiber.dispose()
  })
})
