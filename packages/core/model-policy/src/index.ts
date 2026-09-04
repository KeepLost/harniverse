/** Session-scoped Model Profiles and ordered Model Routes. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  ModelProfile,
  ModelProfileDescriptor,
  ModelProfileSettings,
  ModelProfileSnapshot,
  ModelRoute,
  ModelRouteDescriptor,
  ModelRouteSettings,
  ModelRouteSnapshot,
  ModelSelection,
  ModelTarget,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelPolicy: ModelPolicyService
  }
}

/** Settings namespace containing Model Profile definitions and the default id. */
export const MODEL_PROFILES_SETTINGS_NAMESPACE = settingsNamespace('model-profiles')
/** Settings namespace containing ordered Model Route definitions. */
export const MODEL_ROUTES_SETTINGS_NAMESPACE = settingsNamespace('model-routes')

const targetSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

const modelTargetSchema = z.union([
  z.object({ kind: z.const('model'), selection: targetSchema }),
  z.object({ kind: z.const('route'), route: z.string().required() }),
])

const profileSchema = z.object({
  name: z.string(),
  description: z.string(),
  models: z.array(targetSchema).default([]),
  routes: z.array(z.string()).default([]),
  defaultTarget: modelTargetSchema.required(),
})

const routeSchema = z.object({
  name: z.string(),
  targets: z.array(targetSchema).default([]),
})

const profilesSchema = z.object({
  defaultProfile: z.string().default('unrestricted'),
  profiles: z.dict(profileSchema).default({}),
}) as unknown as z<ModelProfileSettings>

const routesSchema = z.object({
  routes: z.dict(routeSchema).default({}),
}) as unknown as z<ModelRouteSettings>

/** Composition configuration for the policy service. */
export interface Config {
  /** Default Profile for newly created Sessions. */
  readonly defaultProfile?: string
  /** Composition defaults for Model Profiles. */
  readonly profiles?: Readonly<Record<string, ModelProfile>>
  /** Composition defaults for Model Routes. */
  readonly routes?: Readonly<Record<string, ModelRoute>>
}

/** The built-in profile used by old and otherwise unconfigured Sessions. */
export const UNRESTRICTED_MODEL_PROFILE_ID = 'unrestricted'

/** Stable rejection raised when a concrete target is outside a Session Profile. */
export class ModelTargetNotAllowedError extends Error {
  /** Stable machine-readable error code for wire and caller classification. */
  readonly code = 'MODEL_TARGET_NOT_ALLOWED'

  constructor(readonly profileId: string) {
    super(`model target is not allowed by profile "${profileId}"`)
  }
}

/**
 * Find the latest durable Model Profile snapshot in a Session.
 * @param events The ordered Session event history to inspect.
 * @returns The latest Profile snapshot, or undefined when no snapshot exists.
 */
export function effectiveModelProfile(events: readonly SessionEvent[]): ModelProfileSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'model/profile') return event.data
  }
  return undefined
}

/**
 * Find the latest logical target in a Session.
 * @param events The ordered Session event history to inspect.
 * @returns The latest logical target, or undefined when no target exists.
 */
export function effectiveModelTarget(events: readonly SessionEvent[]): ModelTarget | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'model/target') return event.data
  }
  return undefined
}

function selectionKey(selection: ModelSelection): string {
  return `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function revision(snapshot: Omit<ModelProfileSnapshot, 'revision'>): string {
  let hash = 2166136261
  for (const char of stableJson(snapshot)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function detachedSelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Service owning settings, durable snapshots, and target authorization. */
export class ModelPolicyService extends Service {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    defaultProfile: z.string(),
    profiles: z.dict(profileSchema),
    routes: z.dict(routeSchema),
  }) as unknown as z<Config>

  private profileSource: () => ModelProfileSettings
  private routeSource: () => ModelRouteSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'modelPolicy')
    const profileEntry: ModelProfileSettings = {
      defaultProfile: config.defaultProfile ?? UNRESTRICTED_MODEL_PROFILE_ID,
      profiles: config.profiles ?? {},
    }
    const routeEntry: ModelRouteSettings = { routes: config.routes ?? {} }
    this.profileSource = () => profileEntry
    this.routeSource = () => routeEntry
    installSettingsSection(ctx, MODEL_PROFILES_SETTINGS_NAMESPACE, profilesSchema, profileEntry, {
      setSource: (current) => { this.profileSource = current },
      onChange: () => {},
    })
    installSettingsSection(ctx, MODEL_ROUTES_SETTINGS_NAMESPACE, routesSchema, routeEntry, {
      setSource: (current) => { this.routeSource = current },
      onChange: () => {},
    })
  }

  /**
   * Return the currently configured profiles, including unrestricted.
   * @returns detached descriptors in settings order.
   */
  listProfiles(): readonly ModelProfileDescriptor[] {
    const configured = Object.entries(this.profileSource().profiles).map(([id, profile]) => ({
      id,
      name: profile.name ?? id,
      ...profile.description === undefined ? {} : { description: profile.description },
      unrestricted: false,
      defaultTarget: profile.defaultTarget,
    }))
    return [{
      id: UNRESTRICTED_MODEL_PROFILE_ID,
      name: 'Unrestricted',
      description: 'All registered concrete models and routes are allowed.',
      unrestricted: true,
    }, ...configured.filter(profile => profile.id !== UNRESTRICTED_MODEL_PROFILE_ID)]
  }

  /**
   * Return all current route definitions without mutable settings aliases.
   * @returns detached route descriptors in settings order.
   */
  listRoutes(): readonly ModelRouteDescriptor[] {
    return Object.entries(this.routeSource().routes).map(([id, route]) => ({
      id,
      ...route.name === undefined ? {} : { name: route.name },
      targets: route.targets.map(detachedSelection),
      configured: true,
    }))
  }

  /**
   * Resolve the selected default Profile id from live settings.
   * @returns the configured id or unrestricted.
   */
  defaultProfileId(): string {
    return this.profileSource().defaultProfile || UNRESTRICTED_MODEL_PROFILE_ID
  }

  /**
   * Build the durable Session snapshot for one configured Profile.
   * @param profileId - configured Profile id or unrestricted.
   * @returns a detached revisioned snapshot.
   */
  snapshotFor(profileId: string): ModelProfileSnapshot {
    if (profileId === UNRESTRICTED_MODEL_PROFILE_ID) {
      const base: Omit<ModelProfileSnapshot, 'revision'> = {
        id: UNRESTRICTED_MODEL_PROFILE_ID,
        name: 'Unrestricted',
        description: 'All registered concrete models and routes are allowed.',
        unrestricted: true,
        models: [],
        routes: [],
        routeSnapshots: {},
      }
      return { ...base, revision: revision(base) }
    }
    const profile = this.profileSource().profiles[profileId]
    if (profile === undefined) throw new Error(`unknown model profile "${profileId}"`)
    const routeSnapshots: Record<string, ModelRouteSnapshot> = {}
    for (const routeId of profile.routes) {
      const route = this.routeSource().routes[routeId]
      if (route === undefined) throw new Error(`model profile "${profileId}" references unknown route "${routeId}"`)
      routeSnapshots[routeId] = {
        id: routeId,
        ...route.name === undefined ? {} : { name: route.name },
        targets: route.targets.map(detachedSelection),
      }
    }
    const base: Omit<ModelProfileSnapshot, 'revision'> = {
      id: profileId,
      name: profile.name ?? profileId,
      ...profile.description === undefined ? {} : { description: profile.description },
      unrestricted: false,
      models: profile.models.map(detachedSelection),
      routes: [...profile.routes],
      routeSnapshots,
      defaultTarget: profile.defaultTarget,
    }
    return { ...base, revision: revision(base) }
  }

  /**
   * Ensure a Session has a durable Profile.
   * @param session - Session to initialize once.
   * @param profileId - Profile id for a new Session.
   * @returns the existing or newly appended snapshot.
   */
  initialize(session: Session, profileId: string = this.defaultProfileId()): ModelProfileSnapshot {
    const existing = effectiveModelProfile(session.events)
    if (existing !== undefined) return existing
    const snapshot = this.snapshotFor(profileId)
    session.append('model/profile', snapshot)
    if (snapshot.defaultTarget !== undefined) session.append('model/target', snapshot.defaultTarget)
    return snapshot
  }

  /**
   * Change the Session Profile and select its default target.
   * @param session - Session whose policy changes.
   * @param profileId - configured Profile id.
   * @returns the newly appended snapshot.
   */
  setProfile(session: Session, profileId: string): ModelProfileSnapshot {
    const snapshot = this.snapshotFor(profileId)
    session.append('model/profile', snapshot)
    if (snapshot.defaultTarget !== undefined) session.append('model/target', snapshot.defaultTarget)
    return snapshot
  }

  /**
   * Return a Session's effective Profile, pinning legacy Sessions on first use.
   * @param session - Session whose log is inspected.
   * @returns the effective durable snapshot.
   */
  profileOf(session: Session): ModelProfileSnapshot {
    return effectiveModelProfile(session.events) ?? this.initialize(session, UNRESTRICTED_MODEL_PROFILE_ID)
  }

  /**
   * Return the Session's current logical target.
   * @param session - Session whose log is inspected.
   * @returns the latest target, when selected.
   */
  targetOf(session: Session): ModelTarget | undefined {
    return effectiveModelTarget(session.events)
  }

  /**
   * Persist a target after Session Profile authorization.
   * @param session - Session whose target changes.
   * @param target - concrete model or named Route.
   */
  setTarget(session: Session, target: ModelTarget): void {
    const profile = this.profileOf(session)
    if (!this.allowsTarget(profile, target)) {
      throw new ModelTargetNotAllowedError(profile.id)
    }
    session.append('model/target', target)
  }

  /**
   * Check target authorization against an immutable snapshot.
   * @param profile - durable Profile snapshot.
   * @param target - proposed concrete model or Route.
   * @returns whether the target is allowed.
   */
  allowsTarget(profile: ModelProfileSnapshot, target: ModelTarget): boolean {
    if (profile.unrestricted) return true
    if (target.kind === 'route') return profile.routes.includes(target.route)
    return profile.models.some(candidate => selectionKey(candidate) === selectionKey(target.selection))
  }

  /**
   * Check a concrete request, including models inside allowed Routes.
   * @param profile - durable Profile snapshot.
   * @param selection - concrete request target.
   * @returns whether the concrete model is allowed.
   */
  allowsConcrete(profile: ModelProfileSnapshot, selection: ModelSelection): boolean {
    if (profile.unrestricted) return true
    return [...profile.models, ...Object.values(profile.routeSnapshots).flatMap(route => route.targets)]
      .some(candidate => candidate.provider === selection.provider
        && candidate.model === selection.model
        && (candidate.reasoningEffort === undefined || candidate.reasoningEffort === selection.reasoningEffort))
  }

  /**
   * Resolve a logical target to its first concrete attempt.
   * @param session - Session supplying the effective snapshot.
   * @param target - concrete model or named Route.
   * @returns the first concrete attempt, when configured.
   */
  concreteTarget(session: Session, target: ModelTarget): ModelSelection | undefined {
    const profile = this.profileOf(session)
    if (target.kind === 'model') return detachedSelection(target.selection)
    const route = profile.unrestricted
      ? this.routeSource().routes[target.route]
      : profile.routeSnapshots[target.route]
    return route?.targets[0] === undefined ? undefined : detachedSelection(route.targets[0])
  }

  /**
   * Return every concrete attempt in a logical target.
   * @param session - Session supplying the effective snapshot.
   * @param target - concrete model or named Route.
   * @returns detached attempts in fallback order.
   */
  targetsFor(session: Session, target: ModelTarget): readonly ModelSelection[] {
    const profile = this.profileOf(session)
    if (target.kind === 'model') return [detachedSelection(target.selection)]
    const route = profile.unrestricted
      ? this.routeSource().routes[target.route]
      : profile.routeSnapshots[target.route]
    return route?.targets.map(detachedSelection) ?? []
  }

  /**
   * Resolve a target against a not-yet-committed snapshot.
   * @param snapshot - candidate Profile snapshot.
   * @param target - candidate default target.
   * @returns its first concrete attempt, when configured.
   */
  concreteTargetForSnapshot(snapshot: ModelProfileSnapshot, target: ModelTarget): ModelSelection | undefined {
    if (target.kind === 'model') return detachedSelection(target.selection)
    const route = snapshot.unrestricted
      ? this.routeSource().routes[target.route]
      : snapshot.routeSnapshots[target.route]
    return route?.targets[0] === undefined ? undefined : detachedSelection(route.targets[0])
  }

  /**
   * Save the complete Profile settings document.
   * @param next - replacement user settings.
   */
  async saveProfiles(next: ModelProfileSettings): Promise<void> {
    await this.ctx.get('settings')?.replace(MODEL_PROFILES_SETTINGS_NAMESPACE, next)
  }

  /**
   * Save the complete Route settings document.
   * @param next - replacement user settings.
   */
  async saveRoutes(next: ModelRouteSettings): Promise<void> {
    await this.ctx.get('settings')?.replace(MODEL_ROUTES_SETTINGS_NAMESPACE, next)
  }

}

export default ModelPolicyService
