import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import ModelPolicyService, {
  MODEL_PROFILES_SETTINGS_NAMESPACE,
  UNRESTRICTED_MODEL_PROFILE_ID,
  effectiveModelProfile,
  effectiveModelTarget,
} from '../src/index.ts'

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

async function boot(): Promise<{ ctx: Context; policy: ModelPolicyService }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ModelPolicyService, {
    profiles: {
      focused: {
        name: 'Focused',
        models: [{ provider: 'deepseek', model: 'chat' }],
        routes: ['fallback'],
        defaultTarget: { kind: 'route', route: 'fallback' },
      },
    },
    routes: {
      fallback: {
        targets: [
          { provider: 'deepseek', model: 'chat' },
          { provider: 'backup', model: 'chat' },
        ],
      },
    },
  })
  return { ctx, policy: ctx.modelPolicy }
}

describe('ModelPolicyService', () => {
  it('pins legacy sessions as unrestricted and preserves the snapshot', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    const snapshot = policy.profileOf(session)
    expect(snapshot.id).toBe(UNRESTRICTED_MODEL_PROFILE_ID)
    expect(effectiveModelProfile(session.events)).toEqual(snapshot)
    expect(policy.allowsTarget(snapshot, { kind: 'model', selection: { provider: 'any', model: 'model' } })).toBe(true)
    await ctx.fiber.dispose()
  })

  it('captures a configured profile and authorizes only its declared targets', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    const snapshot = policy.initialize(session, 'focused')
    expect(snapshot.id).toBe('focused')
    expect(effectiveModelTarget(session.events)).toEqual({ kind: 'route', route: 'fallback' })
    expect(policy.allowsTarget(snapshot, { kind: 'route', route: 'fallback' })).toBe(true)
    expect(policy.allowsTarget(snapshot, { kind: 'route', route: 'other' })).toBe(false)
    expect(policy.concreteTarget(session, { kind: 'route', route: 'fallback' })).toEqual({
      provider: 'deepseek', model: 'chat',
    })
    await ctx.fiber.dispose()
  })

  it('does not change an existing snapshot when settings are edited', async () => {
    const { ctx, policy } = await boot()
    const session = ctx.sessions.create()
    const original = policy.initialize(session, 'focused')
    await ctx.settings.replace(MODEL_PROFILES_SETTINGS_NAMESPACE, {
      defaultProfile: 'focused',
      profiles: {
        focused: {
          name: 'Focused changed',
          models: [{ provider: 'other', model: 'new' }],
          routes: [],
          defaultTarget: { kind: 'model', selection: { provider: 'other', model: 'new' } },
        },
      },
    })
    expect(policy.profileOf(session)).toEqual(original)
    expect(policy.allowsTarget(original, { kind: 'model', selection: { provider: 'other', model: 'new' } })).toBe(false)
    await ctx.fiber.dispose()
  })
})
