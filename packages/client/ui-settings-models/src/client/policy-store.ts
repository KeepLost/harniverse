/**
 * Model Policy page store: one snapshot joining the resolved `model-policy`
 * settings document (Profiles, Routes, and the default Profile id) with the
 * advisory model catalog (`llm.models`) the pickers offer. The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  IApiClient, ModelProviderGroup, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The policy settings namespace this page owns. */
export const MODEL_POLICY_NS = 'model-policy'

/** One concrete provider/model/effort allowance or target, as the document stores it. */
export interface PolicySelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One logical default target of a Profile. */
export type PolicyTarget =
  | { readonly kind: 'model'; readonly selection: PolicySelection }
  | { readonly kind: 'route'; readonly route: string }

/** One Route row the page renders. */
export interface PolicyRouteRow {
  /** Stable document key; Profiles reference it. */
  readonly id: string
  /** Optional display name; falls back to the id. */
  readonly name: string | undefined
  /** Ordered concrete fallback attempts. */
  readonly targets: readonly PolicySelection[]
  /** The deployment base layer declares this entry, so the user layer cannot remove it. */
  readonly builtin: boolean
}

/** One Profile row the page renders. */
export interface PolicyProfileRow {
  readonly id: string
  readonly name: string | undefined
  readonly description: string | undefined
  /** Concrete models this Profile allows; an entry without an effort admits any effort. */
  readonly models: readonly PolicySelection[]
  /** Route ids this Profile allows. */
  readonly routes: readonly string[]
  readonly builtin: boolean
}

/** One editable Profile inside a {@link PolicyDoc}. */
export interface PolicyDocProfile {
  name?: string
  description?: string
  models: PolicySelection[]
  routes: string[]
  /** Absent while a new Profile's allowances are still empty. */
  defaultTarget?: PolicyTarget
}

/** One editable Route inside a {@link PolicyDoc}. */
export interface PolicyDocRoute {
  name?: string
  targets: PolicySelection[]
}

/** The editable document shape the editors build and save whole. */
export interface PolicyDoc {
  defaultProfile: string
  profiles: Record<string, PolicyDocProfile>
  routes: Record<string, PolicyDocRoute>
}

/** Page snapshot. */
export interface ModelPolicyState {
  /** Principal generation that owns every component-local interaction state. */
  principalGeneration: number
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text. */
  error: string | null
  /** Catalog enrichment failure; the document rows remain editable. */
  catalogError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** The namespace view, for the editors' revision fence. */
  namespace: SettingsNamespaceView | undefined
  defaultProfile: string
  routes: readonly PolicyRouteRow[]
  profiles: readonly PolicyProfileRow[]
  catalog: readonly ModelProviderGroup[]
}

/** First locale key a draft violates, judged by the same rules the host enforces. */
export type PolicyDraftIssue = 'routeNeedsTarget' | 'profileNeedsDefaultTarget'

function detached(selection: PolicySelection): PolicySelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * The one editable-source-of-truth view over the resolved document. Base-layer
 * entries ride along: editing materializes them into the user layer, because
 * arrays replace wholesale and a hand-pruned copy is the only faithful save.
 * @param view - the resolved `model-policy` namespace view.
 * @returns the editable document.
 */
export function policyDocOf(view: SettingsNamespaceView | undefined): PolicyDoc {
  const value = (view?.value ?? {}) as Partial<PolicyDoc>
  const routes: PolicyDoc['routes'] = {}
  for (const [id, route] of Object.entries(value.routes ?? {})) {
    routes[id] = {
      ...route.name === undefined || route.name === '' ? {} : { name: route.name },
      targets: route.targets.map(detached),
    }
  }
  const profiles: PolicyDoc['profiles'] = {}
  for (const [id, profile] of Object.entries(value.profiles ?? {})) {
    profiles[id] = {
      ...profile.name === undefined || profile.name === '' ? {} : { name: profile.name },
      ...profile.description === undefined || profile.description === '' ? {} : { description: profile.description },
      models: profile.models.map(detached),
      routes: [...profile.routes],
      ...profile.defaultTarget === undefined ? {} : {
        defaultTarget: profile.defaultTarget.kind === 'route'
          ? { kind: 'route', route: profile.defaultTarget.route }
          : { kind: 'model', selection: detached(profile.defaultTarget.selection) },
      },
    }
  }
  return {
    defaultProfile: value.defaultProfile ?? 'unrestricted',
    profiles,
    routes,
  }
}

/**
 * Client-side mirror of the host's save-time rules, so the usual mistakes are
 * refused with product copy before the wire round-trip. Constraints the
 * editors cannot produce (dangling references, empty identity strings) stay
 * host-owned.
 * @param doc - the draft document.
 * @returns the first violated copy key, or undefined.
 */
export function policyDraftIssue(doc: PolicyDoc): PolicyDraftIssue | undefined {
  for (const route of Object.values(doc.routes)) {
    if (route.targets.length === 0) return 'routeNeedsTarget'
  }
  for (const profile of Object.values(doc.profiles)) {
    if (profile.defaultTarget === undefined) return 'profileNeedsDefaultTarget'
  }
  return undefined
}

/**
 * Locate a fresh Profile id for a new entry, avoiding every configured key.
 * @param doc - the document the entry joins.
 * @returns the unused id.
 */
export function freshProfileId(doc: PolicyDoc): string {
  let index = Object.keys(doc.profiles).length + 1
  while (doc.profiles[`profile-${String(index)}`] !== undefined) index += 1
  return `profile-${String(index)}`
}

/**
 * Locate a fresh Route id for a new entry, avoiding every configured key.
 * @param doc - the document the entry joins.
 * @returns the unused id.
 */
export function freshRouteId(doc: PolicyDoc): string {
  let index = Object.keys(doc.routes).length + 1
  while (doc.routes[`route-${String(index)}`] !== undefined) index += 1
  return `route-${String(index)}`
}

/** Outcome of one policy write. */
export type PolicySaveOutcome =
  | { kind: 'saved' }
  | { kind: 'superseded' }
  | { kind: 'conflict' }
  | { kind: 'failed'; message: string }

/** The Model Policy page controller (one per settings surface). */
export class ModelPolicyStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelPolicyState> = createSnapshotStore<ModelPolicyState>({
    principalGeneration: 0,
    status: 'idle', error: null, catalogError: null, writable: false, namespace: undefined,
    defaultProfile: 'unrestricted', routes: [], profiles: [], catalog: [],
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  private principalFence: number
  private reloadAfterPrincipal = false
  private readonly stopDescribe: () => void

  /**
   * @param api - the settings and model-catalog wire faces.
   * @param describeFace - shared authorized settings description.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'llm'>,
    private readonly describeFace: SettingsDescribeFace,
  ) {
    this.principalFence = describeFace.writeFence()
    this.stopDescribe = describeFace.subscribe(() => {
      const next = describeFace.writeFence()
      if (next === this.principalFence) return
      this.principalFence = next
      this.reloadAfterPrincipal ||= this.store.getSnapshot().status !== 'idle'
      this.reset()
      if (!this.reloadAfterPrincipal || !describeFace.isCurrent(next)) return
      this.reloadAfterPrincipal = false
      void this.load()
    })
  }

  /** Release the shared mirror subscription owned by this page store. */
  dispose(): void {
    this.stopDescribe()
  }

  /** Clear every settings-derived value at an authenticated connection boundary. */
  reset(): void {
    this.generation += 1
    const principalGeneration = this.store.getSnapshot().principalGeneration + 1
    this.store.set({
      principalGeneration,
      status: 'idle', error: null, catalogError: null, writable: false, namespace: undefined,
      defaultProfile: 'unrestricted', routes: [], profiles: [], catalog: [],
    })
  }

  /**
   * Refresh the whole page snapshot: settings describe and model catalog in
   * parallel. A catalog failure degrades the pickers, not the document rows.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    const fence = this.describeFace.writeFence()
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let namespace: SettingsNamespaceView | undefined
    let writable = false
    let catalog: readonly ModelProviderGroup[] = []
    let catalogError: string | null = null
    try {
      const [catalogResponse] = await Promise.all([
        this.api.llm.models({}),
        this.describeFace.ensure(),
      ])
      if (!this.describeFace.acceptResponse(catalogResponse, fence)) return
      if (catalogResponse.result.ok) catalog = catalogResponse.result.value.groups
      else catalogError = catalogResponse.result.error.message
      const mirrored = this.describeFace.getSnapshot()
      // A resolved mirror read always pairs an absent view with an error text.
      /* v8 ignore next -- the fallback satisfies the nullable type */
      if (mirrored.view === undefined) throw new Error(mirrored.error ?? 'settings are unavailable')
      namespace = mirrored.view.namespaces.find(view => view.ns === MODEL_POLICY_NS)
      writable = mirrored.view.writable
    } catch (error) {
      if (generation !== this.generation || !this.describeFace.isCurrent(fence)) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    if (generation !== this.generation || !this.describeFace.isCurrent(fence)) return
    const doc = policyDocOf(namespace)
    const base = (namespace?.base ?? {}) as Partial<PolicyDoc>
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.catalogError = catalogError
      s.namespace = namespace
      s.writable = writable
      s.defaultProfile = doc.defaultProfile
      s.routes = Object.entries(doc.routes).map(([id, route]) => ({
        id,
        name: route.name,
        targets: route.targets,
        builtin: base.routes?.[id] !== undefined,
      }))
      s.profiles = Object.entries(doc.profiles).map(([id, profile]) => ({
        id,
        name: profile.name,
        description: profile.description,
        models: profile.models,
        routes: profile.routes,
        builtin: base.profiles?.[id] !== undefined,
      }))
      s.catalog = catalog
    })
  }

  /**
   * Persist one complete edited document. The revision fence is the caller's
   * captured open revision, so a concurrent write surfaces as a conflict
   * instead of silently overwriting.
   * @param doc - the replacement user document.
   * @param expectedRevision - the revision the editor opened against.
   * @returns the outcome for the editor to render.
   */
  async save(doc: PolicyDoc, expectedRevision: number): Promise<PolicySaveOutcome> {
    const fence = this.describeFace.writeFence()
    try {
      const response = await this.api.settings.replace({
        ns: MODEL_POLICY_NS,
        section: doc,
        expectedRevision,
      })
      if (!this.describeFace.acceptResponse(response, fence)) return { kind: 'superseded' }
      if (!response.result.ok) {
        return response.result.error.code === 'settings-conflict'
          ? { kind: 'conflict' }
          : { kind: 'failed', message: response.result.error.message }
      }
      this.describeFace.acceptView(response.result.value, fence, response.authentication)
      return { kind: 'saved' }
    } catch (error) {
      if (!this.describeFace.isCurrent(fence)) return { kind: 'superseded' }
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
}
