/** Capability kinds projected by the shipped Harness adapters. */
export type CapabilityKind = 'tool' | 'skill' | 'mcp-server' | 'subagent-provider'

/** Stable origin of the implementation behind a capability. */
export type CapabilityProvenance = 'upstream' | 'harniverse-added' | 'harniverse-adapted' | 'external' | 'unknown'

/** A Profile composition entry. Omission means inherit. */
export type CapabilitySelectionValue = 'load' | 'unload'

/** JSON primitive accepted by one explicitly declared Profile configuration field. */
export type CapabilityConfigValue = string | number | boolean

/** Model-discoverable member contributed by one assembled capability. */
export interface CapabilityMemberDescriptor {
  readonly id: string
  readonly kind: 'tool' | 'skill' | 'mcp-tool' | 'subagent-provider'
  readonly name: string
  readonly description: string
  readonly defaultVisible: boolean
  readonly available: boolean
  readonly requires: readonly string[]
}

/** One Profile-safe field a capability owner permits the assembly editor to change. */
export interface CapabilityConfigurationField {
  readonly id: string
  readonly kind: 'text' | 'boolean' | 'number'
  readonly name: string
  readonly description: string
  readonly required?: boolean
  readonly multiline?: boolean
}

/** Capability-owned configuration contract and source-Profile defaults. */
export interface CapabilityCustomizationDescriptor {
  readonly fields: readonly CapabilityConfigurationField[]
  readonly defaultValues: Readonly<Record<string, CapabilityConfigValue>>
}

/** Explicit assembly override stored for one global or Profile target. */
export interface CapabilityOverride {
  readonly selection?: CapabilitySelectionValue
  /** Presence selects only these stable member ids; omission inherits. */
  readonly members?: readonly string[]
  /** Field-level overrides over native then global values. */
  readonly config?: Readonly<Record<string, CapabilityConfigValue>>
}

/** Target edited by one composition transaction. */
export type CapabilityTarget =
  | { readonly kind: 'global-agent' }
  | { readonly kind: 'agent-profile'; readonly agentProfile: string }

/** One capability recipe before target selection is applied. */
export interface CapabilityDescriptor {
  readonly id: string
  readonly kind: CapabilityKind
  readonly name: string
  readonly description: string
  readonly provenance: CapabilityProvenance
  /** Whether this deployment has a recipe that can assemble the capability. */
  readonly assembleable: boolean
  /** Whether the implementation is currently healthy when that can be observed. */
  readonly available: boolean
  /** Selection inherited when neither global nor Profile settings override it. */
  readonly defaultLoaded: boolean
  readonly manageable: boolean
  /** Whether load/unload is editable; false may still allow owner-declared configuration. */
  readonly selectionManageable?: boolean
  readonly owner?: string
  readonly requires: readonly string[]
  readonly members?: readonly CapabilityMemberDescriptor[]
  readonly customization?: CapabilityCustomizationDescriptor
}

/** One member as the selected target currently resolves it. */
export interface CapabilityMemberCatalogEntry extends CapabilityMemberDescriptor {
  readonly visible: boolean
}

/** One capability as a target currently resolves it. */
export interface CapabilityCatalogEntry extends CapabilityDescriptor {
  readonly selection: 'inherit' | CapabilitySelectionValue
  readonly effectiveSelection: CapabilitySelectionValue
  readonly selected: boolean
  readonly memberSelection?: 'inherit' | 'custom'
  readonly memberEntries?: readonly CapabilityMemberCatalogEntry[]
  readonly configOverrides?: Readonly<Record<string, CapabilityConfigValue>>
  readonly effectiveConfig?: Readonly<Record<string, CapabilityConfigValue>>
}

/** Point-in-time target catalog and composition revision. */
export interface CapabilityCatalogSnapshot {
  readonly target: CapabilityTarget
  readonly revision: number
  readonly topologyRevision: number
  readonly complete: boolean
  readonly entries: readonly CapabilityCatalogEntry[]
}

/** One staged composition edit. */
export interface CapabilityCompositionChange {
  readonly capabilityId: string
  readonly selection?: 'inherit' | CapabilitySelectionValue
  readonly members?: 'inherit' | readonly string[]
  readonly config?: 'inherit' | Readonly<Record<string, CapabilityConfigValue>>
}

/** One explicit selection transition in a plan. */
export interface CapabilityPlanOperation {
  readonly capabilityId: string
  readonly before: 'inherit' | CapabilitySelectionValue
  readonly after: 'inherit' | CapabilitySelectionValue
  readonly membersChanged?: boolean
  readonly configChanged?: boolean
}

/** Why a candidate composition cannot be applied safely. */
export interface CapabilityPlanBlocker {
  readonly code: 'unknown-capability' | 'not-manageable' | 'not-assembleable' | 'required-unloaded' | 'required-unassembleable' | 'unknown-member' | 'required-member-hidden' | 'member-name-conflict' | 'configuration-unsupported' | 'configuration-invalid'
  readonly capabilityId: string
  readonly dependencyId?: string
  /** Capability claiming the same member name, for `member-name-conflict`. */
  readonly conflictingCapabilityId?: string
  readonly message: string
}

/** Immutable dry-run accepted by `apply` only at the revisions it observed. */
export interface CapabilityPlan {
  readonly id: string
  readonly target: CapabilityTarget
  readonly expectedRevision: number
  readonly topologyRevision: number
  readonly operations: readonly CapabilityPlanOperation[]
  readonly blockers: readonly CapabilityPlanBlocker[]
  readonly result: readonly CapabilityCatalogEntry[]
}

/** Snapshot returned after a composition transaction commits. */
export interface CapabilityCompositionSnapshot {
  readonly target: CapabilityTarget
  readonly revision: number
  readonly values: Readonly<Record<string, CapabilityOverride>>
}

/** Result of assembling one immutable Session generation. */
export type CapabilityRuntimeStatus = 'loaded' | 'not-loaded' | 'load-failed' | 'dependency-blocked' | 'security-denied'

/** One recipe's immutable result in a Session generation. */
export interface CapabilityRuntimeEntry extends CapabilityCatalogEntry {
  readonly status: CapabilityRuntimeStatus
  readonly reason?: string
}

/** Runtime composition shown for one live Session. */
export interface SessionCapabilitySnapshot {
  readonly sessionId: string
  readonly agentProfile?: string
  readonly generation?: string
  readonly entries: readonly CapabilityRuntimeEntry[]
}
