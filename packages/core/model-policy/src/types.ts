import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One concrete provider/model request target. */
export interface ModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Optional adapter-owned reasoning effort. */
  readonly reasoningEffort?: string
}

/** One target accepted by a Model Profile or selected in a Session. */
export type ModelTarget =
  | {
    /** Select one concrete model. */
    readonly kind: 'model'
    /** Concrete provider/model selection. */
    readonly selection: ModelSelection
  }
  | {
    /** Select one named ordered Route. */
    readonly kind: 'route'
    /** Configured Route id. */
    readonly route: string
  }

/** An ordered fallback chain of concrete model targets. */
export interface ModelRoute {
  /** Optional display name. */
  readonly name?: string
  /** Concrete attempts in fallback order. */
  readonly targets: readonly ModelSelection[]
}

/** User-configured permissions and default target for one Model Profile. */
export interface ModelProfile {
  /** Optional display name. */
  readonly name?: string
  /** Optional user-facing explanation. */
  readonly description?: string
  /** Concrete models allowed by this Profile. */
  readonly models: readonly ModelSelection[]
  /** Named Routes allowed by this Profile. */
  readonly routes: readonly string[]
  /** Target used when the Profile is selected. */
  readonly defaultTarget: ModelTarget
}

/** Settings section for independently editable Model Profiles. */
export interface ModelProfileSettings {
  readonly defaultProfile: string
  readonly profiles: Readonly<Record<string, ModelProfile>>
}

/** Settings section for independently editable Model Routes. */
export interface ModelRouteSettings {
  readonly routes: Readonly<Record<string, ModelRoute>>
}

/** Immutable route captured into a restricted Session policy snapshot. */
export interface ModelRouteSnapshot {
  readonly id: string
  readonly name?: string
  readonly targets: readonly ModelSelection[]
}

/** Immutable Session-scoped policy. Missing legacy events mean unrestricted. */
export interface ModelProfileSnapshot {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly unrestricted: boolean
  readonly models: readonly ModelSelection[]
  readonly routes: readonly string[]
  readonly routeSnapshots: Readonly<Record<string, ModelRouteSnapshot>>
  readonly defaultTarget?: ModelTarget
  readonly revision: string
}

/** Durable transition between concrete attempts in one logical Model Route. */
export interface ModelFallbackEvent {
  readonly turn: number
  readonly step: number
  readonly route: string
  readonly from: ModelSelection
  readonly to: ModelSelection
  readonly failure: {
    readonly message: string
    readonly code: string
    readonly status?: number
  }
}

/** Public descriptor returned by profile discovery APIs. */
export interface ModelProfileDescriptor {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly unrestricted: boolean
  readonly defaultTarget?: ModelTarget
}

/** Public descriptor returned by route discovery APIs. */
export interface ModelRouteDescriptor extends ModelRouteSnapshot {
  readonly configured: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Captures the Model Profile permissions used by this Session. */
    'model/profile': ModelProfileSnapshot
    /** Records the logical model or route used by subsequent requests. */
    'model/target': ModelTarget
    /** Records a categorized cross-model fallback attempt. */
    'model/fallback': ModelFallbackEvent
  }
}

/** Durable events owned by the Model Policy service. */
export type ModelPolicyEvent = Extract<SessionEvent, { type: 'model/profile' | 'model/target' }>
