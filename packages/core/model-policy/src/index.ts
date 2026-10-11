/** Session-scoped Model Profiles and ordered Model Routes. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  ModelPolicySettings,
  ModelProfile,
  ModelProfileDescriptor,
  ModelProfileSnapshot,
  ModelRoute,
  ModelRouteDescriptor,
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

/** Settings namespace holding the complete Model Policy document. */
export const MODEL_POLICY_SETTINGS_NAMESPACE = settingsNamespace('model-policy')

/** The built-in profile used by old and otherwise unconfigured Sessions. */
export const UNRESTRICTED_MODEL_PROFILE_ID = 'unrestricted'

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

const policySchema = z.object({
  defaultProfile: z.string().default(UNRESTRICTED_MODEL_PROFILE_ID),
  profiles: z.dict(profileSchema).default({}),
  routes: z.dict(routeSchema).default({}),
}) as unknown as z<ModelPolicySettings>

/** Composition configuration for the policy service. */
export interface Config {
  /** Default Profile for newly created Sessions. */
  readonly defaultProfile?: string
  /** Composition defaults for Model Profiles. */
  readonly profiles?: Readonly<Record<string, ModelProfile>>
  /** Composition defaults for Model Routes. */
  readonly routes?: Readonly<Record<string, ModelRoute>>
}

/** Stable rejection raised when a concrete target is outside a Session Profile. */
export class ModelTargetNotAllowedError extends Error {
  /** Stable machine-readable error code for wire and caller classification. */
  readonly code = 'MODEL_TARGET_NOT_ALLOWED'

  constructor(readonly profileId: string) {
    super(`model target is not allowed by profile "${profileId}"`)
  }
}

/**
 * Whether one allowed-model entry admits a concrete selection. An entry
 * without a reasoning effort is the wildcard: any effort of that model is
 * allowed, which is how the filtered catalog and concrete authorization
 * already read it.
 * @param entry - the Profile-declared allowance.
 * @param selection - the concrete request target.
 * @returns whether the entry admits the selection.
 */
function entryAdmits(entry: ModelSelection, selection: ModelSelection): boolean {
  return entry.provider === selection.provider
    && entry.model === selection.model
    && (entry.reasoningEffort === undefined || entry.reasoningEffort === selection.reasoningEffort)
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

/**
 * Reject a resolved policy document whose references would only explode at
 * Session time: dangling Route references, default targets outside the
 * Profile's own allowances, an unknown default Profile, and empty identity
 * strings that would render as unnamed rows. Save-time rejection is the
 * earliest point where the complete merged document is known.
 * @param value - the schema-resolved policy document.
 * @throws Error naming the first violated invariant.
 */
export function validateModelPolicySettings(value: ModelPolicySettings): void {
  for (const [routeId, route] of Object.entries(value.routes)) {
    if (route.name === '') throw new Error(`route "${routeId}" has an empty name`)
    if (route.targets.length === 0) throw new Error(`route "${routeId}" needs at least one target`)
    for (const [index, target] of route.targets.entries()) {
      if (target.provider === '') throw new Error(`route "${routeId}" target ${index + 1} needs a provider`)
      if (target.model === '') throw new Error(`route "${routeId}" target ${index + 1} needs a model`)
      if (target.reasoningEffort === '') throw new Error(`route "${routeId}" target ${index + 1} has an empty reasoning effort`)
    }
  }
  for (const [profileId, profile] of Object.entries(value.profiles)) {
    if (profileId === UNRESTRICTED_MODEL_PROFILE_ID) {
      throw new Error(`profile id "${UNRESTRICTED_MODEL_PROFILE_ID}" is reserved for the built-in profile`)
    }
    if (profile.name === '') throw new Error(`profile "${profileId}" has an empty name`)
    for (const routeId of profile.routes) {
      if (value.routes[routeId] === undefined) {
        throw new Error(`profile "${profileId}" references unknown route "${routeId}"`)
      }
    }
    for (const [index, entry] of profile.models.entries()) {
      if (entry.provider === '') throw new Error(`profile "${profileId}" model ${index + 1} needs a provider`)
      if (entry.model === '') throw new Error(`profile "${profileId}" model ${index + 1} needs a model`)
      if (entry.reasoningEffort === '') throw new Error(`profile "${profileId}" model ${index + 1} has an empty reasoning effort`)
    }
    const target = profile.defaultTarget
    if (target.kind === 'route') {
      if (!profile.routes.includes(target.route)) {
        throw new Error(`profile "${profileId}" defaults to route "${target.route}" outside its allowed routes`)
      }
    } else {
      const selection = target.selection
      if (!profile.models.some(entry => entryAdmits(entry, selection))) {
        throw new Error(`profile "${profileId}" defaults to model "${selection.provider}/${selection.model}" outside its allowed models`)
      }
    }
  }
  const defaultProfile = value.defaultProfile
  if (defaultProfile !== UNRESTRICTED_MODEL_PROFILE_ID && value.profiles[defaultProfile] === undefined) {
    throw new Error(`default profile "${defaultProfile}" is not configured`)
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

  private source: () => ModelPolicySettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'modelPolicy')
    const entry: ModelPolicySettings = {
      defaultProfile: config.defaultProfile ?? UNRESTRICTED_MODEL_PROFILE_ID,
      profiles: config.profiles ?? {},
      routes: config.routes ?? {},
    }
    // The composition entry is judged by the same rules as a stored edit, so
    // a miscomposed deployment fails at its earliest resolvable point.
    validateModelPolicySettings(entry)
    this.source = () => entry
    installSettingsSection(ctx, MODEL_POLICY_SETTINGS_NAMESPACE, policySchema, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => {},
      validate: validateModelPolicySettings,
    })
  }

  /**
   * Return the currently configured profiles, including unrestricted.
   * @returns detached descriptors in settings order.
   */
  listProfiles(): readonly ModelProfileDescriptor[] {
    const configured = Object.entries(this.source().profiles).map(([id, profile]) => ({
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
    }, ...configured]
  }

  /**
   * Return all current route definitions without mutable settings aliases.
   * @returns detached route descriptors in settings order.
   */
  listRoutes(): readonly ModelRouteDescriptor[] {
    return Object.entries(this.source().routes).map(([id, route]) => ({
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
    return this.source().defaultProfile
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
    const profile = this.source().profiles[profileId]
    if (profile === undefined) throw new Error(`unknown model profile "${profileId}"`)
    const routeSnapshots: Record<string, ModelRouteSnapshot> = {}
    for (const routeId of profile.routes) {
      const route = this.source().routes[routeId]
      /* v8 ignore next -- save-time validation owns the reference invariant, so a resolved document cannot dangle */
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
   * Check target authorization against an immutable snapshot. A Profile model
   * entry without a reasoning effort admits any effort of that model, matching
   * how the catalog filter and concrete authorization read the same entry.
   * @param profile - durable Profile snapshot.
   * @param target - proposed concrete model or Route.
   * @returns whether the target is allowed.
   */
  allowsTarget(profile: ModelProfileSnapshot, target: ModelTarget): boolean {
    if (profile.unrestricted) return true
    if (target.kind === 'route') return profile.routes.includes(target.route)
    return profile.models.some(candidate => entryAdmits(candidate, target.selection))
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
      ? this.source().routes[target.route]
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
      ? this.source().routes[target.route]
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
      ? this.source().routes[target.route]
      : snapshot.routeSnapshots[target.route]
    return route?.targets[0] === undefined ? undefined : detachedSelection(route.targets[0])
  }

  /**
   * Save the complete Model Policy settings document.
   * @param next - replacement user settings.
   */
  async savePolicy(next: ModelPolicySettings): Promise<void> {
    await this.ctx.get('settings')?.replace(MODEL_POLICY_SETTINGS_NAMESPACE, next)
  }
}

export default ModelPolicyService
