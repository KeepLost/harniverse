/** State owner for scoped Profile composition drafts and transactions. */

import type {
  CapabilityCatalogSnapshot,
  CapabilityPlan,
  CapabilityCompositionChange,
  CapabilityCompositionSnapshot,
  CapabilityTarget,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Profile target shown beside the global Agent default. */
export interface CapabilityProfileOption {
  readonly id: string
  readonly name: string
}

/** Transport-independent wire face consumed by the controller. */
export interface CapabilityCompositionWire {
  listProfiles(): Promise<readonly CapabilityProfileOption[]>
  catalog(target: CapabilityTarget): Promise<CapabilityCatalogSnapshot>
  plan(
    target: CapabilityTarget,
    changes: readonly CapabilityCompositionChange[],
    expectedRevision: number,
  ): Promise<CapabilityPlan>
  apply(planId: string, expectedRevision: number): Promise<CapabilityCompositionSnapshot>
}

/** Complete state rendered by the Profile composition tab. */
export interface CapabilityCompositionState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly profiles: readonly CapabilityProfileOption[]
  readonly target: CapabilityTarget
  readonly catalog: CapabilityCatalogSnapshot | null
  readonly draft: Readonly<Record<string, 'inherit' | 'load' | 'unload'>>
  readonly plan: CapabilityPlan | null
  readonly planning: boolean
  readonly applying: boolean
}

const GLOBAL_TARGET: CapabilityTarget = { kind: 'global-agent' }

const INITIAL: CapabilityCompositionState = {
  status: 'idle',
  error: null,
  profiles: [],
  target: GLOBAL_TARGET,
  catalog: null,
  draft: {},
  plan: null,
  planning: false,
  applying: false,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameTarget(left: CapabilityTarget, right: CapabilityTarget): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'global-agent' || left.agentProfile === (right as { agentProfile: string }).agentProfile
}

/** Coordinates target reads, local drafts, server planning, and fenced apply. */
export class CapabilityCompositionController {
  /** Observable page snapshot consumed through the slot renderer's bound hook. */
  readonly store: SnapshotStore<CapabilityCompositionState> = createSnapshotStore(INITIAL)
  private request = 0

  constructor(private readonly wire: CapabilityCompositionWire) {}

  private set(patch: Partial<CapabilityCompositionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Load the target roster and global Agent defaults. */
  async load(): Promise<void> {
    const request = ++this.request
    this.set({ status: 'loading', error: null })
    try {
      const [profiles, catalog] = await Promise.all([
        this.wire.listProfiles(),
        this.wire.catalog(GLOBAL_TARGET),
      ])
      if (request !== this.request) return
      this.set({
        status: 'ready',
        profiles,
        target: GLOBAL_TARGET,
        catalog,
        draft: {},
        plan: null,
        planning: false,
        applying: false,
      })
    } catch (error) {
      if (request !== this.request) return
      this.set({ status: 'error', error: messageOf(error), planning: false, applying: false })
    }
  }

  /**
   * Read another target, dropping drafts that belong to the previous one.
   * @param target - global Agent defaults or one Agent Profile.
   */
  async selectTarget(target: CapabilityTarget): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.planning || state.applying || sameTarget(state.target, target)) return
    const request = ++this.request
    this.set({ status: 'loading', error: null, target, draft: {}, plan: null })
    try {
      const catalog = await this.wire.catalog(target)
      if (request !== this.request) return
      this.set({ status: 'ready', catalog })
    } catch (error) {
      if (request !== this.request) return
      this.set({ status: 'error', error: messageOf(error), catalog: null })
    }
  }

  /**
   * Stage one explicit load/unload/inherit value.
   * @param capabilityId - stable capability identity from the current catalog.
   * @param selection - explicit value, or inherit to remove the target override.
   */
  setSelection(capabilityId: string, selection: 'inherit' | 'load' | 'unload'): void {
    const state = this.store.getSnapshot()
    const entry = state.catalog?.entries.find(candidate => candidate.id === capabilityId)
    if (entry?.manageable !== true || state.planning || state.applying) return
    const draft = { ...state.draft }
    if (entry.selection === selection) Reflect.deleteProperty(draft, capabilityId)
    else draft[capabilityId] = selection
    this.set({ draft, plan: null, error: null })
  }

  /** Drop every staged value and preview. */
  discard(): void {
    const state = this.store.getSnapshot()
    if (state.planning || state.applying) return
    this.set({ draft: {}, plan: null, error: null })
  }

  /** Ask the Host to validate the complete staged composition transaction. */
  async preview(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.catalog === null || state.planning || state.applying) return
    const changes = Object.entries(state.draft).map(([capabilityId, selection]) => ({ capabilityId, selection }))
    if (changes.length === 0) return
    this.set({ planning: true, plan: null, error: null })
    try {
      const plan = await this.wire.plan(state.target, changes, state.catalog.revision)
      if (!sameTarget(this.store.getSnapshot().target, state.target)) return
      this.set({ planning: false, plan })
    } catch (error) {
      this.set({ planning: false, error: messageOf(error) })
    }
  }

  /** Commit the last unblocked plan and refresh its target. */
  async apply(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.plan === null || state.plan.blockers.length > 0 || state.applying || state.planning) return
    this.set({ applying: true, error: null })
    try {
      await this.wire.apply(state.plan.id, state.plan.expectedRevision)
    } catch (error) {
      this.set({ applying: false, error: messageOf(error) })
      return
    }
    this.set({ draft: {}, plan: null })
    try {
      const catalog = await this.wire.catalog(state.target)
      this.set({
        status: 'ready',
        applying: false,
        catalog,
      })
    } catch (error) {
      this.set({ status: 'error', applying: false, error: messageOf(error), catalog: null })
    }
  }
}
