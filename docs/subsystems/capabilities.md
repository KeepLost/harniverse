# Agent Capabilities

English | [中文](capabilities.zh.md)

[`dsh-capabilities`](../../packages/capability/capabilities/README.md) owns the typed recipe catalog and composition planner shared by Tool, Skill, MCP-server, and Subagent-provider adapters. A `CapabilityDescriptor` distinguishes an assembleable recipe from current implementation health and carries its source-Profile default, manageability, owner, provenance, and hard dependency ids. Every target projects the same deployment-wide recipe id set; target-specific `selection`, `effectiveSelection`, and `selected` values describe the desired composition without mounting that Profile.

A `CapabilityTarget` is either the global Agent defaults or one Agent Profile. Omitted values inherit, global `load` or `unload` values flow into every Profile, and a Profile value overrides the inherited value. With no stored value, each Profile retains the native loaded state of its YAML rows. `CapabilityPlan` is an immutable revision-fenced dry-run: it adds assembleable hard dependencies, records effective operations and blockers, and is accepted only while composition and adapter topology revisions remain unchanged.

`dsh-agent-presets` reads top-level rows and groups as static recipes, then compiles changed selections into native `Include` patches when the next standing generation starts. A load may insert a canonical deployment row missing from the target Profile; an unload disables its source row. Hard activation failure rolls Session creation back. MCP adapters can additionally remove one Host-shared server's tools from a Profile without terminating its connection. Running Sessions remain pinned to their original generation, and the Session **Capabilities** view reads the immutable loaded, not-loaded, failed, dependency-blocked, or security-denied result captured before publication. The [composition Agent Note](../../.agents/notes/implemented/architecture/2026-08-20-scoped-capability-control-plane.md) owns this boundary.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilities--capabilities"></a>

### `ctx.capabilities` — `Capabilities`

Generic capability recipe registry, composition store, planner, and Profile generation installer.

```ts cordis-catalog
/**
 * Register one native subsystem adapter on the calling plugin fiber.
 * @param create - factory receiving the registration-owned invalidation handle.
 * @returns exact disposer for the scoped adapter registration.
 */
registerAdapter(create: (control: CapabilityAdapterControl) => CapabilityAdapter): () => void

/**
 * Read the effective catalog for one global or Agent Profile target.
 * @param target - composition target whose explicit and inherited values are resolved.
 * @param view - native registry scopes and workspace used by adapters.
 * @returns deterministic capability entries and current composition/topology revisions.
 */
async snapshot(target: CapabilityTarget, view: CapabilityView = {}): Promise<CapabilityCatalogSnapshot>

/**
 * Read current explicit values for one composition target.
 * @param target - global Agent defaults or one Agent Profile.
 * @returns explicit values with the current Settings revision.
 */
composition(target: CapabilityTarget): CapabilityCompositionSnapshot

/**
 * Build the stable effective selection identity included in a Profile generation stamp.
 * @param agentProfile - Profile whose inherited and explicit values are resolved.
 * @param descriptors - complete recipe and runtime adapter snapshot for this generation.
 * @returns sorted JSON identity of the effective composition.
 */
selectionSignature(agentProfile: string, descriptors: readonly CapabilityDescriptor[]): string

/**
 * Apply current effective unloads through every visible native adapter in a standing Profile scope.
 * @param ctx - scoped standing Profile context that owns the restrictions.
 * @param entries - immutable selections resolved for this generation.
 */
mountComposition(ctx: Context, entries: readonly CapabilityCatalogEntry[]): void

/**
 * Build and retain one dry-run against exact composition and topology revisions.
 * @param target - composition target edited by the transaction.
 * @param changes - staged explicit load, unload, or inherit values.
 * @param expectedRevision - Settings revision the editor observed.
 * @param view - native registry scopes and workspace used by adapters.
 * @returns immutable plan with operations, blockers, and resulting catalog.
 */
async plan( target: CapabilityTarget, changes: readonly CapabilityCompositionChange[], expectedRevision: number, view: CapabilityView = {}, ): Promise<CapabilityPlan>

/**
 * Commit one previously planned composition transaction.
 * @param planId - retained plan identity returned by {@link plan}.
 * @param expectedRevision - Settings revision the plan observed.
 * @returns committed explicit selection values and new revision.
 */
async apply(planId: string, expectedRevision: number): Promise<CapabilityCompositionSnapshot>
```

Source: [`packages/capability/capabilities/src/index.ts:93`](../../packages/capability/capabilities/src/index.ts)

<a id="capabilities-events"></a>

### `capabilities/*` events

<a id="capabilitieschange--emit"></a>

#### `capabilities/change` — emit

Capability topology or composition changed; consumers refetch their target. @mode emit

```ts cordis-catalog
/** Capability topology or composition changed; consumers refetch their target. @mode emit */
'capabilities/change'(): void
```

Source: [`packages/capability/capabilities/src/index.ts:88`](../../packages/capability/capabilities/src/index.ts)
<!-- END GENERATED cordis-surface -->
