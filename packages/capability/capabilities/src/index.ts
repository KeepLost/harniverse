/** Agent Profile capability recipe and composition coordinator. @module @deepseek-ai/dsh-capabilities */

import { Context, Service } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { SettingsNamespace, SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {
  CapabilityCatalogEntry,
  CapabilityCatalogSnapshot,
  CapabilityDescriptor,
  CapabilityPlan,
  CapabilityPlanBlocker,
  CapabilityPlanOperation,
  CapabilityCompositionChange,
  CapabilityCompositionSnapshot,
  CapabilityConfigValue,
  CapabilityOverride,
  CapabilitySelectionValue,
  CapabilityTarget,
} from './types.ts'

export type * from './types.ts'

/** Adapter catalog observation. */
export interface CapabilityObservation {
  readonly entries: readonly CapabilityDescriptor[]
  readonly complete: boolean
}

/** Scope and workspace used to project one target's native registries. */
export interface CapabilityView {
  readonly scope?: ScopeKey
  /** Additional roots merged for a deployment-wide Agent catalog. */
  readonly scopes?: readonly ScopeKey[]
  readonly cwd?: string
  readonly signal?: AbortSignal
  /** Profile whose source composition supplies recipe defaults. */
  readonly agentProfile?: string
}

/** Registration-scoped invalidation handle borrowed by one adapter. */
export interface CapabilityAdapterControl {
  readonly signal: AbortSignal
  invalidate(): void
}

/** Native subsystem projection and generation-scoped selection application. */
export interface CapabilityAdapter {
  readonly id: string
  snapshot(view: CapabilityView): Promise<CapabilityObservation> | CapabilityObservation
  restrict?(ctx: Context, entries: readonly CapabilityCatalogEntry[]): void
}

interface CompositionDocument {
  readonly global: Record<string, CapabilityOverride>
  readonly profiles: Record<string, Record<string, CapabilityOverride>>
}

type StoredOverride = CapabilitySelectionValue | CapabilityOverride

interface StoredCompositionDocument {
  readonly global: Record<string, StoredOverride>
  readonly profiles: Record<string, Record<string, StoredOverride>>
}

interface StoredPlan {
  readonly public: CapabilityPlan
  readonly next: CompositionDocument
}

interface AdapterRegistration {
  readonly adapter: CapabilityAdapter
  readonly scope: ScopeKey | undefined
}

function scopeVisible(registrationScope: ScopeKey | undefined, view: CapabilityView): boolean {
  if (registrationScope === undefined) return true
  const roots = [view.scope, ...(view.scopes ?? [])]
  return roots.some(root => scopeChainOf(root).includes(registrationScope))
}

const SETTINGS_NAMESPACE = 'capabilities' as SettingsNamespace
const OVERRIDE = z.union([
  z.union(['load', 'unload'] as const),
  z.object({
    selection: z.union(['load', 'unload'] as const),
    // Schemastery materializes omitted array/dict schemas as empty values;
    // keeping these optional payloads opaque preserves omission = inherit.
    // Planner validation below owns their exact persisted shape.
    members: z.any(),
    config: z.any(),
  }),
])
const OVERRIDES = z.dict(OVERRIDE).default({})
const SETTINGS: z<StoredCompositionDocument> = z.object({
  global: OVERRIDES,
  profiles: z.dict(OVERRIDES).default({}),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilities: Capabilities
  }

  interface Events {
    /** Capability topology or composition changed; consumers refetch their target. @mode emit */
    'capabilities/change'(): void
  }
}

/** Generic capability recipe registry, composition store, planner, and Profile generation installer. */
export class Capabilities extends Service {
  private readonly adapters = new Set<AdapterRegistration>()
  private readonly plans = new Map<string, StoredPlan>()
  private settingsScope: SettingsScope<StoredCompositionDocument> | undefined
  private settingsService: SettingsProvider | undefined
  private topologyRevision = 0
  private nextPlanId = 1

  constructor(ctx: Context) {
    super(ctx, 'capabilities')
    ctx.inject(['settings'], (settingsCtx) => {
      this.settingsScope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SETTINGS)
      this.settingsService = settingsCtx.settings
      const stop = this.settingsScope.watch(() => {
        this.plans.clear()
        this.notifyChange()
      })
      settingsCtx.effect(() => () => {
        stop()
        this.settingsScope = undefined
        this.settingsService = undefined
        this.plans.clear()
      }, 'capabilities.settings()')
    })
  }

  /**
   * Register one native subsystem adapter on the calling plugin fiber.
   * @param create - factory receiving the registration-owned invalidation handle.
   * @returns exact disposer for the scoped adapter registration.
   */
  registerAdapter(create: (control: CapabilityAdapterControl) => CapabilityAdapter): () => void {
    const lifecycle = new AbortController()
    let adapter: CapabilityAdapter
    let registration: AdapterRegistration | undefined
    try {
      adapter = create({
        signal: lifecycle.signal,
        invalidate: () => {
          if (registration === undefined || !this.adapters.has(registration)) return
          this.topologyRevision += 1
          this.plans.clear()
          this.notifyChange()
        },
      })
      assertStableId(adapter.id, 'adapter id')
      const owned: AdapterRegistration = { adapter, scope: scopeOf(this.ctx) }
      registration = owned
      if ([...this.adapters].some(candidate => candidate.adapter.id === adapter.id && candidate.scope === owned.scope)) {
        throw new Error(`capabilities: adapter ${JSON.stringify(adapter.id)} is already registered`)
      }
      const dispose = this.ctx.effect(() => {
        this.adapters.add(owned)
        this.topologyRevision += 1
        this.plans.clear()
        this.notifyChange()
        return () => {
          if (!this.adapters.delete(owned)) return
          lifecycle.abort(new Error(`capability adapter ${JSON.stringify(adapter.id)} disposed`))
          this.topologyRevision += 1
          this.plans.clear()
          this.notifyChange()
        }
      }, `capabilities.registerAdapter(${JSON.stringify(adapter.id)})`)
      return () => { void dispose() }
    } catch (error) {
      lifecycle.abort(error)
      throw error
    }
  }

  /**
   * Read the effective catalog for one global or Agent Profile target.
   * @param target - composition target whose explicit and inherited values are resolved.
   * @param view - native registry scopes and workspace used by adapters.
   * @returns deterministic capability entries and current composition/topology revisions.
   */
  async snapshot(target: CapabilityTarget, view: CapabilityView = {}): Promise<CapabilityCatalogSnapshot> {
    assertTarget(target)
    const descriptors = new Map<string, CapabilityDescriptor>()
    let complete = true
    for (const { adapter, scope } of this.adapters) {
      if (!scopeVisible(scope, view)) continue
      view.signal?.throwIfAborted()
      const observation = await adapter.snapshot(view)
      if (!observation.complete) complete = false
      const availableInTarget = view.scope === undefined || scopeVisible(scope, { scope: view.scope })
      for (const descriptor of observation.entries) {
        validateDescriptor(descriptor, adapter.id)
        const copied = copyDescriptor({
          ...descriptor,
          available: descriptor.available && availableInTarget,
        })
        const previous = descriptors.get(descriptor.id)
        if (previous !== undefined) {
          if (JSON.stringify(previous) === JSON.stringify(copied)) continue
          throw new Error(`capabilities: conflicting capability id ${JSON.stringify(descriptor.id)} from adapter ${JSON.stringify(adapter.id)}`)
        }
        descriptors.set(descriptor.id, copied)
      }
    }
    return {
      target,
      revision: this.settingsRevision(),
      topologyRevision: this.topologyRevision,
      complete,
      entries: catalogEntries(descriptors, this.document(), target),
    }
  }

  /**
   * Read current explicit values for one composition target.
   * @param target - global Agent defaults or one Agent Profile.
   * @returns explicit values with the current Settings revision.
   */
  composition(target: CapabilityTarget): CapabilityCompositionSnapshot {
    assertTarget(target)
    return {
      target,
      revision: this.settingsRevision(),
      values: structuredClone(targetValues(this.document(), target)),
    }
  }

  /**
   * Build the stable effective assembly identity included in a Profile generation stamp.
   * @param agentProfile - Profile whose inherited and explicit values are resolved.
   * @param descriptors - complete recipe and runtime adapter snapshot for this generation.
   * @returns sorted JSON identity of selection, visible members, and resolved configuration.
   */
  compositionSignature(agentProfile: string, descriptors: readonly CapabilityDescriptor[]): string {
    assertProfileId(agentProfile)
    const target = { kind: 'agent-profile', agentProfile } as const
    const document = this.document()
    const values = Object.fromEntries(descriptors.map((descriptor) => {
      const entry = catalogEntry(descriptor, document, target)
      return [descriptor.id, {
        selection: entry.effectiveSelection,
        members: entry.memberEntries?.filter(member => member.visible).map(member => member.id) ?? [],
        config: entry.effectiveConfig ?? {},
      }]
    }))
    return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))))
  }

  /**
   * Apply current selection and member restrictions through every visible native adapter.
   * @param ctx - scoped standing Profile context that owns the restrictions.
   * @param entries - immutable selections resolved for this generation.
   */
  mountComposition(ctx: Context, entries: readonly CapabilityCatalogEntry[]): void {
    const currentScope = scopeOf(ctx)
    const view: CapabilityView = currentScope === undefined ? {} : { scope: currentScope }
    for (const { adapter, scope } of this.adapters) {
      if (scopeVisible(scope, view)) adapter.restrict?.(ctx, entries)
    }
  }

  // capability-planning-anchor

  /**
   * Build and retain one dry-run against exact composition and topology revisions.
   * @param target - composition target edited by the transaction.
   * @param changes - staged selection, member allowlist, and typed configuration overrides.
   * @param expectedRevision - Settings revision the editor observed.
   * @param view - native registry scopes and workspace used by adapters.
   * @returns immutable plan with operations, blockers, and resulting catalog.
   */
  async plan(
    target: CapabilityTarget,
    changes: readonly CapabilityCompositionChange[],
    expectedRevision: number,
    view: CapabilityView = {},
  ): Promise<CapabilityPlan> {
    const snapshot = await this.snapshot(target, view)
    if (snapshot.revision !== expectedRevision) {
      throw new Error(`capabilities: stale composition revision ${String(expectedRevision)}; current revision is ${String(snapshot.revision)}`)
    }
    const descriptors = new Map(snapshot.entries.map(entry => [entry.id, descriptorOf(entry)]))
    const before = targetValues(this.document(), target)
    const after = structuredClone(before)
    const blockers: CapabilityPlanBlocker[] = []
    const seen = new Set<string>()
    for (const change of changes) {
      assertStableId(change.capabilityId, 'capability change id')
      if (seen.has(change.capabilityId)) {
        throw new Error(`capabilities: duplicate change for ${JSON.stringify(change.capabilityId)}`)
      }
      seen.add(change.capabilityId)
      const descriptor = descriptors.get(change.capabilityId)
      if (descriptor === undefined) {
        blockers.push({
          code: 'unknown-capability',
          capabilityId: change.capabilityId,
          message: `Capability ${change.capabilityId} is not present in this target catalog.`,
        })
      } else if (!descriptor.manageable) {
        blockers.push({
          code: 'not-manageable',
          capabilityId: change.capabilityId,
          message: `Capability ${change.capabilityId} is shared or read-only in this target.`,
        })
      } else if (change.selection !== undefined && descriptor.selectionManageable === false) {
        blockers.push({
          code: 'not-manageable',
          capabilityId: change.capabilityId,
          message: `Capability ${change.capabilityId} must remain loaded in this target.`,
        })
      } else if (change.selection === 'load' && !descriptor.assembleable) {
        blockers.push({
          code: 'not-assembleable',
          capabilityId: change.capabilityId,
          message: `Capability ${change.capabilityId} has no recipe available to load.`,
        })
      }
      const current = { ...after[change.capabilityId] }
      if (change.selection === 'inherit') Reflect.deleteProperty(current, 'selection')
      else if (change.selection !== undefined) current.selection = change.selection
      if (change.members === 'inherit') Reflect.deleteProperty(current, 'members')
      else if (change.members !== undefined) {
        const known = new Set(descriptor?.members?.map(member => member.id) ?? [])
        for (const memberId of change.members) {
          if (!known.has(memberId)) blockers.push({
            code: 'unknown-member',
            capabilityId: change.capabilityId,
            dependencyId: memberId,
            message: `Capability ${change.capabilityId} does not declare member ${memberId}.`,
          })
        }
        current.members = [...new Set(change.members)].sort((left, right) => left.localeCompare(right))
      }
      if (change.config === 'inherit') Reflect.deleteProperty(current, 'config')
      else if (change.config !== undefined) {
        if (descriptor?.customization === undefined) blockers.push({
          code: 'configuration-unsupported',
          capabilityId: change.capabilityId,
          message: `Capability ${change.capabilityId} does not expose Profile configuration.`,
        })
        else validateConfigurationChange(change.capabilityId, descriptor, change.config, blockers)
        current.config = { ...change.config }
      }
      if (Object.keys(current).length === 0) Reflect.deleteProperty(after, change.capabilityId)
      else after[change.capabilityId] = current
    }
    const operationIds = new Set(seen)
    let next = withTargetValues(this.document(), target, after)
    let result = catalogEntries(descriptors, next, target)
    let expanded = true
    while (expanded) {
      expanded = false
      const byId = new Map(result.map(entry => [entry.id, entry]))
      for (const entry of result) {
        if (!entry.selected) continue
        for (const dependencyId of entry.requires) {
          const dependency = byId.get(dependencyId)
          if (dependency === undefined || dependency.selected || !dependency.assembleable || !dependency.manageable) continue
          if (seen.has(dependencyId)) continue
          after[dependencyId] = { ...after[dependencyId], selection: 'load' }
          operationIds.add(dependencyId)
          expanded = true
        }
      }
      if (expanded) {
        next = withTargetValues(this.document(), target, after)
        result = catalogEntries(descriptors, next, target)
      }
    }
    blockers.push(...dependencyBlockers(result))
    blockers.push(...memberNameConflicts(result))
    const operations: CapabilityPlanOperation[] = [...operationIds].flatMap((capabilityId) => {
      const previous = before[capabilityId]
      const following = after[capabilityId]
      const beforeSelection = previous?.selection ?? 'inherit'
      const afterSelection = following?.selection ?? 'inherit'
      const membersChanged = JSON.stringify(previous?.members) !== JSON.stringify(following?.members)
      const configChanged = JSON.stringify(previous?.config) !== JSON.stringify(following?.config)
      return beforeSelection === afterSelection && !membersChanged && !configChanged ? [] : [{
        capabilityId,
        before: beforeSelection,
        after: afterSelection,
        ...membersChanged ? { membersChanged: true } : {},
        ...configChanged ? { configChanged: true } : {},
      }]
    })
    const plan: CapabilityPlan = {
      id: `capability-plan-${String(this.nextPlanId)}`,
      target,
      expectedRevision,
      topologyRevision: snapshot.topologyRevision,
      operations,
      blockers: dedupeBlockers(blockers),
      result,
    }
    this.nextPlanId += 1
    this.plans.set(plan.id, { public: structuredClone(plan), next })
    return plan
  }

  /**
   * Commit one previously planned composition transaction.
   * @param planId - retained plan identity returned by {@link plan}.
   * @param expectedRevision - Settings revision the plan observed.
   * @returns committed explicit assembly overrides and new revision.
   */
  async apply(planId: string, expectedRevision: number): Promise<CapabilityCompositionSnapshot> {
    const stored = this.plans.get(planId)
    if (stored === undefined) throw new Error(`capabilities: unknown or expired plan ${JSON.stringify(planId)}`)
    const plan = stored.public
    if (plan.blockers.length > 0) throw new Error(`capabilities: plan ${JSON.stringify(planId)} is blocked`)
    if (plan.expectedRevision !== expectedRevision || this.settingsRevision() !== expectedRevision) {
      throw new Error(`capabilities: stale composition revision ${String(expectedRevision)}; current revision is ${String(this.settingsRevision())}`)
    }
    if (plan.topologyRevision !== this.topologyRevision) {
      throw new Error(`capabilities: capability topology changed after plan ${JSON.stringify(planId)} was created`)
    }
    const settings = this.settingsService
    if (settings === undefined) throw new Error('capabilities: settings service is unavailable; composition is read-only')
    await settings.replace(SETTINGS_NAMESPACE, stored.next, expectedRevision)
    this.plans.delete(planId)
    return this.composition(plan.target)
  }

  private document(): CompositionDocument {
    const current = this.settingsScope?.get()
    return current === undefined
      ? { global: {}, profiles: {} }
      : normalizeDocument(current)
  }

  private settingsRevision(): number {
    const descriptor = this.settingsService?.describe().find(candidate => candidate.ns === SETTINGS_NAMESPACE)
    return descriptor?.revision ?? 0
  }

  /** Notify observers without allowing one listener to veto registry state. */
  private notifyChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['capabilities/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn('capabilities/change listener rejected', error)
        })
      } catch (error) {
        this.ctx.logger.warn('capabilities/change listener threw', error)
      }
    }
  }
}

const STABLE_ID = /^[a-z0-9][a-z0-9._:/-]*$/
const PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/
const CONFIG_FIELD_ID = /^[a-z][A-Za-z0-9]*$/

function assertStableId(value: string, field: string): void {
  if (!STABLE_ID.test(value)) throw new TypeError(`capabilities: ${field} must be a stable lowercase id`)
}

function assertProfileId(value: string): void {
  if (!PROFILE_ID.test(value)) throw new TypeError(`capabilities: invalid Agent Profile id ${JSON.stringify(value)}`)
}

function assertConfigFieldId(value: string, descriptorId: string): void {
  if (!CONFIG_FIELD_ID.test(value) || value === 'constructor' || value === 'prototype') {
    throw new TypeError(`capabilities: configuration field of ${JSON.stringify(descriptorId)} must be a safe config key`)
  }
}

function assertTarget(target: CapabilityTarget): void {
  switch (target.kind) {
    case 'global-agent': return
    case 'agent-profile':
      assertProfileId(target.agentProfile)
      return
    default: {
      const unreachable: never = target
      throw new TypeError(`capabilities: unsupported target ${JSON.stringify(unreachable)}`)
    }
  }
}

function validateDescriptor(descriptor: CapabilityDescriptor, adapterId: string): void {
  assertStableId(descriptor.id, `descriptor id from ${JSON.stringify(adapterId)}`)
  if (descriptor.name.trim() !== descriptor.name || descriptor.name.length === 0) {
    throw new TypeError(`capabilities: descriptor ${JSON.stringify(descriptor.id)} has an invalid name`)
  }
  if (descriptor.description.trim() !== descriptor.description || descriptor.description.length === 0) {
    throw new TypeError(`capabilities: descriptor ${JSON.stringify(descriptor.id)} has an invalid description`)
  }
  const dependencies = new Set<string>()
  for (const dependency of descriptor.requires) {
    assertStableId(dependency, `dependency of ${JSON.stringify(descriptor.id)}`)
    if (dependency === descriptor.id) {
      throw new Error(`capabilities: descriptor ${JSON.stringify(descriptor.id)} requires itself`)
    }
    if (dependencies.has(dependency)) {
      throw new Error(`capabilities: descriptor ${JSON.stringify(descriptor.id)} repeats dependency ${JSON.stringify(dependency)}`)
    }
    dependencies.add(dependency)
  }
  const memberIds = new Set<string>()
  for (const member of descriptor.members ?? []) {
    assertStableId(member.id, `member id of ${JSON.stringify(descriptor.id)}`)
    if (memberIds.has(member.id)) throw new Error(`capabilities: descriptor ${JSON.stringify(descriptor.id)} repeats member ${JSON.stringify(member.id)}`)
    memberIds.add(member.id)
    if (member.name.trim() !== member.name || member.name.length === 0) {
      throw new TypeError(`capabilities: member ${JSON.stringify(member.id)} has an invalid name`)
    }
    for (const required of member.requires) assertStableId(required, `dependency of member ${JSON.stringify(member.id)}`)
  }
  const fieldIds = new Set<string>()
  for (const field of descriptor.customization?.fields ?? []) {
    assertConfigFieldId(field.id, descriptor.id)
    if (fieldIds.has(field.id)) throw new Error(`capabilities: descriptor ${JSON.stringify(descriptor.id)} repeats configuration field ${JSON.stringify(field.id)}`)
    fieldIds.add(field.id)
  }
}

function copyDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    name: descriptor.name,
    description: descriptor.description,
    provenance: descriptor.provenance,
    assembleable: descriptor.assembleable,
    available: descriptor.available,
    defaultLoaded: descriptor.defaultLoaded,
    manageable: descriptor.manageable,
    ...descriptor.selectionManageable === undefined ? {} : { selectionManageable: descriptor.selectionManageable },
    ...descriptor.owner === undefined ? {} : { owner: descriptor.owner },
    requires: [...descriptor.requires],
    ...descriptor.members === undefined ? {} : { members: descriptor.members.map(copyMember) },
    ...descriptor.customization === undefined ? {} : {
      customization: {
        fields: descriptor.customization.fields.map(field => ({ ...field })),
        defaultValues: { ...descriptor.customization.defaultValues },
      },
    },
  }
}

function descriptorOf(entry: CapabilityCatalogEntry): CapabilityDescriptor {
  const { selection: _selection, effectiveSelection: _effectiveSelection, selected: _selected, ...descriptor } = entry
  return descriptor
}

function targetValues(document: CompositionDocument, target: CapabilityTarget): Record<string, CapabilityOverride> {
  return target.kind === 'global-agent'
    ? document.global
    : document.profiles[target.agentProfile] ?? {}
}

function effectiveSelection(
  document: CompositionDocument,
  target: CapabilityTarget,
  descriptor: CapabilityDescriptor,
): CapabilitySelectionValue {
  if (target.kind === 'agent-profile') {
    const profile = document.profiles[target.agentProfile]?.[descriptor.id]?.selection
    if (profile !== undefined) return profile
  }
  return document.global[descriptor.id]?.selection ?? (descriptor.defaultLoaded ? 'load' : 'unload')
}

function withTargetValues(
  document: CompositionDocument,
  target: CapabilityTarget,
  values: Record<string, CapabilityOverride>,
): CompositionDocument {
  if (target.kind === 'global-agent') return { global: { ...values }, profiles: structuredClone(document.profiles) }
  const profiles = structuredClone(document.profiles)
  if (Object.keys(values).length === 0) Reflect.deleteProperty(profiles, target.agentProfile)
  else profiles[target.agentProfile] = { ...values }
  return { global: { ...document.global }, profiles }
}

function catalogEntries(
  descriptors: ReadonlyMap<string, CapabilityDescriptor>,
  document: CompositionDocument,
  target: CapabilityTarget,
): CapabilityCatalogEntry[] {
  return [...descriptors.values()]
    .map(descriptor => catalogEntry(descriptor, document, target))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
}

function catalogEntry(
  descriptor: CapabilityDescriptor,
  document: CompositionDocument,
  target: CapabilityTarget,
): CapabilityCatalogEntry {
  const explicit = targetValues(document, target)[descriptor.id]
  const resolved = effectiveSelection(document, target, descriptor)
  const memberIds = effectiveMembers(document, target, descriptor)
  const effectiveConfig = effectiveConfiguration(document, target, descriptor)
  return {
    ...copyDescriptor(descriptor),
    selection: explicit?.selection ?? 'inherit',
    effectiveSelection: resolved,
    selected: resolved === 'load',
    ...descriptor.members === undefined ? {} : {
      memberSelection: explicit?.members === undefined ? 'inherit' : 'custom',
      memberEntries: descriptor.members.map(member => ({ ...copyMember(member), visible: memberIds.has(member.id) })),
    },
    ...descriptor.customization === undefined ? {} : {
      configOverrides: { ...explicit?.config },
      effectiveConfig,
    },
  }
}

function effectiveMembers(
  document: CompositionDocument,
  target: CapabilityTarget,
  descriptor: CapabilityDescriptor,
): ReadonlySet<string> {
  const native = descriptor.members?.filter(member => member.defaultVisible).map(member => member.id) ?? []
  const global = document.global[descriptor.id]?.members
  if (target.kind === 'global-agent') return new Set(global ?? native)
  return new Set(document.profiles[target.agentProfile]?.[descriptor.id]?.members ?? global ?? native)
}

function effectiveConfiguration(
  document: CompositionDocument,
  target: CapabilityTarget,
  descriptor: CapabilityDescriptor,
): Readonly<Record<string, CapabilityConfigValue>> {
  if (descriptor.customization === undefined) return {}
  const global = document.global[descriptor.id]?.config ?? {}
  const profile = target.kind === 'agent-profile'
    ? document.profiles[target.agentProfile]?.[descriptor.id]?.config ?? {}
    : {}
  return { ...descriptor.customization.defaultValues, ...global, ...profile }
}

function copyMember(member: NonNullable<CapabilityDescriptor['members']>[number]) {
  return { ...member, requires: [...member.requires] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function normalizeConfig(value: unknown): Record<string, CapabilityConfigValue> {
  if (!isRecord(value)) throw new TypeError('capabilities: stored override config must be an object')
  const normalized: Record<string, CapabilityConfigValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new TypeError('capabilities: stored override config must contain JSON primitive values')
    }
    normalized[key] = item
  }
  return normalized
}

function normalizeOverride(value: unknown): CapabilityOverride {
  if (typeof value === 'string') {
    if (value !== 'load' && value !== 'unload') throw new TypeError('capabilities: stored override has an invalid selection')
    return { selection: value }
  }
  if (!isRecord(value)) throw new TypeError('capabilities: stored override must be an object')
  const selection = value.selection
  if (selection !== undefined && selection !== 'load' && selection !== 'unload') {
    throw new TypeError('capabilities: stored override has an invalid selection')
  }
  if (value.members !== undefined && !isStringArray(value.members)) {
    throw new TypeError('capabilities: stored override members must be an array of stable ids')
  }
  return {
    ...selection === undefined ? {} : { selection },
    ...value.members === undefined ? {} : { members: [...value.members] },
    ...value.config === undefined ? {} : { config: normalizeConfig(value.config) },
  }
}

function normalizeDocument(document: StoredCompositionDocument): CompositionDocument {
  return {
    global: Object.fromEntries(Object.entries(document.global).map(([id, value]) => [id, normalizeOverride(value)])),
    profiles: Object.fromEntries(Object.entries(document.profiles).map(([profile, values]) => [
      profile,
      Object.fromEntries(Object.entries(values).map(([id, value]) => [id, normalizeOverride(value)])),
    ])),
  }
}

function validateConfigurationChange(
  capabilityId: string,
  descriptor: CapabilityDescriptor,
  config: Readonly<Record<string, CapabilityConfigValue>>,
  blockers: CapabilityPlanBlocker[],
): void {
  const fields = new Map(descriptor.customization?.fields.map(field => [field.id, field]) ?? [])
  for (const [fieldId, value] of Object.entries(config)) {
    const field = fields.get(fieldId)
    const valid = field !== undefined && (
      field.kind === 'text' && typeof value === 'string'
      || field.kind === 'boolean' && typeof value === 'boolean'
      || field.kind === 'number' && typeof value === 'number' && Number.isFinite(value)
    )
    if (valid) continue
    blockers.push({
      code: 'configuration-invalid',
      capabilityId,
      dependencyId: fieldId,
      message: `Capability ${capabilityId} has an invalid value for configuration field ${fieldId}.`,
    })
  }
}

function dependencyBlockers(entries: readonly CapabilityCatalogEntry[]): CapabilityPlanBlocker[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const blockers: CapabilityPlanBlocker[] = []
  for (const entry of entries) {
    if (!entry.selected) continue
    for (const dependencyId of entry.requires) {
      const dependency = byId.get(dependencyId)
      if (dependency === undefined || !dependency.assembleable) {
        blockers.push({
          code: 'required-unassembleable',
          capabilityId: entry.id,
          dependencyId,
          message: `Capability ${entry.id} requires capability ${dependencyId}, which has no assembly recipe.`,
        })
      } else if (!dependency.selected) {
        blockers.push({
          code: 'required-unloaded',
          capabilityId: entry.id,
          dependencyId,
          message: `Capability ${entry.id} requires unloaded capability ${dependencyId}.`,
        })
      }
    }
    const members = new Map(entry.memberEntries?.map(member => [member.id, member]) ?? [])
    for (const member of members.values()) {
      if (!member.visible) continue
      for (const dependencyId of member.requires) {
        if (members.get(dependencyId)?.visible === true) continue
        blockers.push({
          code: 'required-member-hidden',
          capabilityId: entry.id,
          dependencyId,
          message: `Capability ${entry.id} member ${member.id} requires hidden member ${dependencyId}.`,
        })
      }
    }
  }
  return blockers
}

/**
 * Two selected capabilities that would claim one native registry name.
 *
 * A registry name has a single owner per scope, so a second registration under
 * it throws at mount and fails the whole Profile generation — the Session then
 * has no composition at all. The catalog knows the visible member names before
 * anything mounts, so the collision is a plan blocker rather than a mount
 * crash. Only visible members of selected capabilities can collide: a hidden
 * member registers nothing.
 * @param entries - the candidate composition this plan would install.
 * @returns one blocker per colliding capability pair and name.
 */
function memberNameConflicts(entries: readonly CapabilityCatalogEntry[]): CapabilityPlanBlocker[] {
  const owners = new Map<string, Map<string, string>>()
  const blockers: CapabilityPlanBlocker[] = []
  for (const entry of entries) {
    if (!entry.selected) continue
    for (const member of entry.memberEntries ?? []) {
      if (!member.visible) continue
      const byName = owners.get(member.kind) ?? new Map<string, string>()
      owners.set(member.kind, byName)
      const owner = byName.get(member.name)
      if (owner === undefined) {
        byName.set(member.name, entry.id)
        continue
      }
      blockers.push({
        code: 'member-name-conflict',
        capabilityId: entry.id,
        dependencyId: member.id,
        conflictingCapabilityId: owner,
        message: `Capability ${entry.id} registers ${member.kind} ${member.name}, which capability ${owner} already registers. Unload one of them.`,
      })
    }
  }
  return blockers
}

function dedupeBlockers(blockers: readonly CapabilityPlanBlocker[]): CapabilityPlanBlocker[] {
  const unique = new Map<string, CapabilityPlanBlocker>()
  for (const blocker of blockers) {
    unique.set(`${blocker.code}:${blocker.capabilityId}:${blocker.dependencyId ?? ''}`, blocker)
  }
  return [...unique.values()]
}

export default Capabilities
