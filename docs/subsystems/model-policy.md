# Model Policy

English | [中文](model-policy.zh.md)

Model Policy is the session-scoped model authorization subsystem. [`dsh-model-policy`](../../packages/core/model-policy) owns the `model-profiles` and `model-routes` Settings sections, durable Session snapshots, and target authorization. [`dsh-model-policy-fallback`](../../packages/core/model-policy-fallback) consumes the policy and advances an ordered Route after same-model recovery delegates.

## Model targets

`ModelSelection` identifies one concrete provider/model pair and an optional adapter-owned reasoning effort. `ModelTarget` selects either one concrete model or one named `ModelRoute`. A Route contains concrete selections in fallback order.

## Session events

Model Policy extends [`SessionEventMap`](session.md) with three log-only events:

| Event | Payload | Role |
|---|---|---|
| `model/profile` | `ModelProfileSnapshot` | Immutable Profile authorization and Route definitions captured for the Session. |
| `model/target` | `ModelTarget` | Logical target selected for subsequent model requests. |
| `model/fallback` | `ModelFallbackEvent` | Categorized transition from one concrete Route attempt to the next. |

An old Session without `model/profile` resolves as the built-in `unrestricted` Profile. A configured Profile snapshot does not change when its Settings document changes. A target change affects later requests and does not rewrite the conversation surface.

## Authorization

Every Host model-selection mutation checks the Session snapshot before committing `model/target`. Restricted Profiles allow their declared concrete models and all concrete attempts captured by their declared Routes. The `llm/stream` boundary also checks requests carrying a Session id, covering auxiliary compaction and title calls as well as the Agent loop.

## Fallback

`dsh-llm-retry` retains ownership of bounded retry and backoff for one concrete provider route. Model Policy fallback delegates to that policy first. If it returns no retry action and the current target is a Route, the fallback Consumer appends `model/fallback`, then the next Agent request reconstructs the replacement concrete target from the Session log. Cancellation never advances a Route.

## Cordis API

The generated [`Cordis API catalog`](../cordis-api/context.md) carries `ctx.modelPolicy` and its public methods. Settings writes remain under the existing `ctx.settings` service and the two namespaces documented in the package README.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelpolicy--modelpolicyservice"></a>

### `ctx.modelPolicy` — `ModelPolicyService`

Service owning settings, durable snapshots, and target authorization.

```ts cordis-catalog
/**
 * Return the currently configured profiles, including unrestricted.
 * @returns detached descriptors in settings order.
 */
listProfiles(): readonly ModelProfileDescriptor[]

/**
 * Return all current route definitions without mutable settings aliases.
 * @returns detached route descriptors in settings order.
 */
listRoutes(): readonly ModelRouteDescriptor[]

/**
 * Resolve the selected default Profile id from live settings.
 * @returns the configured id or unrestricted.
 */
defaultProfileId(): string

/**
 * Build the durable Session snapshot for one configured Profile.
 * @param profileId - configured Profile id or unrestricted.
 * @returns a detached revisioned snapshot.
 */
snapshotFor(profileId: string): ModelProfileSnapshot

/**
 * Ensure a Session has a durable Profile.
 * @param session - Session to initialize once.
 * @param profileId - Profile id for a new Session.
 * @returns the existing or newly appended snapshot.
 */
initialize(session: Session, profileId: string = this.defaultProfileId()): ModelProfileSnapshot

/**
 * Change the Session Profile and select its default target.
 * @param session - Session whose policy changes.
 * @param profileId - configured Profile id.
 * @returns the newly appended snapshot.
 */
setProfile(session: Session, profileId: string): ModelProfileSnapshot

/**
 * Return a Session's effective Profile, pinning legacy Sessions on first use.
 * @param session - Session whose log is inspected.
 * @returns the effective durable snapshot.
 */
profileOf(session: Session): ModelProfileSnapshot

/**
 * Return the Session's current logical target.
 * @param session - Session whose log is inspected.
 * @returns the latest target, when selected.
 */
targetOf(session: Session): ModelTarget | undefined

/**
 * Persist a target after Session Profile authorization.
 * @param session - Session whose target changes.
 * @param target - concrete model or named Route.
 */
setTarget(session: Session, target: ModelTarget): void

/**
 * Check target authorization against an immutable snapshot.
 * @param profile - durable Profile snapshot.
 * @param target - proposed concrete model or Route.
 * @returns whether the target is allowed.
 */
allowsTarget(profile: ModelProfileSnapshot, target: ModelTarget): boolean

/**
 * Check a concrete request, including models inside allowed Routes.
 * @param profile - durable Profile snapshot.
 * @param selection - concrete request target.
 * @returns whether the concrete model is allowed.
 */
allowsConcrete(profile: ModelProfileSnapshot, selection: ModelSelection): boolean

/**
 * Resolve a logical target to its first concrete attempt.
 * @param session - Session supplying the effective snapshot.
 * @param target - concrete model or named Route.
 * @returns the first concrete attempt, when configured.
 */
concreteTarget(session: Session, target: ModelTarget): ModelSelection | undefined

/**
 * Return every concrete attempt in a logical target.
 * @param session - Session supplying the effective snapshot.
 * @param target - concrete model or named Route.
 * @returns detached attempts in fallback order.
 */
targetsFor(session: Session, target: ModelTarget): readonly ModelSelection[]

/**
 * Resolve a target against a not-yet-committed snapshot.
 * @param snapshot - candidate Profile snapshot.
 * @param target - candidate default target.
 * @returns its first concrete attempt, when configured.
 */
concreteTargetForSnapshot(snapshot: ModelProfileSnapshot, target: ModelTarget): ModelSelection | undefined

/**
 * Save the complete Profile settings document.
 * @param next - replacement user settings.
 */
async saveProfiles(next: ModelProfileSettings): Promise<void>

/**
 * Save the complete Route settings document.
 * @param next - replacement user settings.
 */
async saveRoutes(next: ModelRouteSettings): Promise<void>
```

Types: [Session](session.md)

Source: [`packages/core/model-policy/src/index.ts:144`](../../packages/core/model-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
