# Resource Governor

English | [中文](governor.zh.md)

The governor meters correlated shell/terminal spawns and enforces the shared-pool memory budget. The [governor Agent Note](../../.agents/notes/implemented/architecture/2026-09-12-resource-governor-metering-and-quotas.md) owns the tier model and quota semantics; the [package README](../../packages/monitor/governor/README.md) owns composition, the Remote surface, and configuration. This page records the wire-facing shapes from [`packages/monitor/governor/src/types.ts`](../../packages/monitor/governor/src/types.ts).

## Samples and views

`ResourceSample` is one per-command tick: CPU ticks since the previous sample, whole-tree RSS/PSS, kernel disk byte deltas, the open-descriptor count, and TCP byte deltas when attributable. `CommandView` is the frozen per-command record the Remote serves — live commands first, then settled ones, each with its bounded sample ring and cumulative totals.

```ts type-equiv
/** One per-command sample produced by a metering tick. */
interface ResourceSample {
  /** Tick timestamp, epoch milliseconds. */
  readonly t: number
  /** CPU used since the previous sample, in kernel clock ticks (100/s). */
  readonly cpuTicks: number
  /** Whole-tree resident memory in bytes (statm RSS sum). */
  readonly rssBytes: number
  /** Whole-tree proportional-set memory in bytes, when readable. */
  readonly pssBytes?: number
  /** Kernel block-layer disk bytes read/written since the previous sample. */
  readonly readBytes: number
  readonly writeBytes: number
  /** Open file-descriptor count for the tree (whole-process granularity). */
  readonly fdCount: number
  /** TCP bytes sent/received since the previous sample, when attributable. */
  readonly netTxBytes?: number
  readonly netRxBytes?: number
}
```

```ts type-equiv
/** Public read-only shape of one tracked command. */
interface CommandView {
  readonly sessionId: string
  readonly commandId: string
  readonly kind: 'shell' | 'terminal' | 'other'
  readonly startedAt: number
  readonly exitedAt?: number
  readonly samples: readonly ResourceSample[]
  readonly peakRssBytes: number
  readonly totalCpuTicks: number
  readonly totalReadBytes: number
  readonly totalWriteBytes: number
  readonly breach?: GovernorBreachRecord
}
```

## Quotas and breaches

`SessionQuotaState` reports the effective budget enforcement applies to one session: its explicit quota when it has one (an isolation leaf), else the shared global budget. `GovernorBreachRecord` is one enforcement kill — the reason the model sees in the bash tool result, the peak observed, and the budget exceeded.

```ts type-equiv
/** Effective quota state of one session. */
interface SessionQuotaState {
  readonly sessionId: string
  /** Explicit quota in bytes, when the session has one (isolation leaf). */
  readonly quotaBytes?: number
  /** The budget enforcement currently applies to this session's commands. */
  readonly effectiveLimitBytes: number
  /** True while the session rides the shared pool (no explicit quota). */
  readonly shared: boolean
}
```

```ts type-equiv
/** One enforcement kill, kept for the tool-result merge and the board. */
interface GovernorBreachRecord {
  readonly kind: GovernorBreachKind
  readonly sessionId: string
  readonly commandId: string
  /** Peak RSS observed at breach time, when known. */
  readonly peakBytes?: number
  /** The budget that was exceeded, when known. */
  readonly limitBytes?: number
  readonly at: number
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgovernor--governorservice"></a>

### `ctx.governor` — `GovernorService`

The resource governor service. See the package README and the Agent Note (`2026-09-12-resource-governor-metering-and-quotas`) for the tier model, shared-pool semantics, and sandbox-realm integration contract.

```ts cordis-catalog
/**
 * Spawn bounds for one session — the tool-bash collaboration seam. Every
 * metered command carries its session's effective limit: an explicit quota
 * for leaf sessions, the shared global budget for pool members.
 * @param sessionId - session id.
 * @returns the limits the provider should enforce.
 */
limitsFor(sessionId: string): { maxMemoryBytes?: number } | undefined

/**
 * Breach facts for one command — the tool-bash result-merge seam.
 * @param commandId - command id.
 * @returns the recorded breach when one exists.
 */
breachFor(commandId: string): GovernorBreachRecord | undefined

/**
 * Effective quota state for one session.
 * @param sessionId - session id.
 * @returns the explicit quota (when set), effective limit, and pool membership.
 */
quotaStateOf(sessionId: string): SessionQuotaState

/**
 * Adjust one session's quota (board/HTTP path — operate capability).
 * @param sessionId - session id.
 * @param memoryBytes - explicit quota in bytes, or null to rejoin the pool.
 * @param reason - audit trail origin of the decision.
 * @returns the session's quota state after admission and persistence.
 */
async adjustQuota(sessionId: string, memoryBytes: number | null, reason: 'board' | 'tool' | 'clear'): Promise<SessionQuotaState>

/**
 * Board overview (`harniverse.observe`).
 * @returns tier, global budget usage, per-session rows, and host sentinels.
 */
@Remote({ exportName: 'overview', requiredCapability: 'harniverse.observe' }) overview(): GovernorOverview

/**
 * Per-session command views (`harniverse.observe`).
 * @param sessionId - session id.
 * @returns live commands first, then settled ones, with sample rings.
 */
@Remote({ exportName: 'sessionSamples', requiredCapability: 'harniverse.observe' }) sessionSamples(sessionId: string): CommandView[]

/**
 * Read one session's quota state (`harniverse.observe`).
 * @param sessionId - session id.
 * @returns the explicit quota, effective limit, and pool membership.
 */
@Remote({ exportName: 'sessionQuotaGet', requiredCapability: 'harniverse.observe' }) sessionQuotaGet(sessionId: string): SessionQuotaState

/**
 * Adjust one session's quota (`harniverse.operate`).
 * @param sessionId - session id.
 * @param memoryBytes - explicit quota in bytes, or null to rejoin the pool.
 * @returns the session's quota state after admission and persistence.
 */
@Remote({ exportName: 'sessionQuotaAdjust', requiredCapability: 'harniverse.operate' }) async sessionQuotaAdjust(sessionId: string, memoryBytes: number | null): Promise<SessionQuotaState>

/**
   * Breach history, newest first (`harniverse.observe`).
   * @returns the bounded breach list.
   */
@Remote({ exportName: 'breaches', requiredCapability: 'harniverse.observe' }) breaches(): readonly GovernorBreachRecord[]

/**
   * Effective settings plus the resolved budget (`harniverse.observe`).
   * @returns the config with `globalLimitBytes` attached.
   */
@Remote({ exportName: 'configGet', requiredCapability: 'harniverse.observe' }) configGet(): GovernorConfig & { globalLimitBytes: number }

/** Re-resolve settings and re-apply the global budget (`harniverse.administer`). */
@Remote({ exportName: 'reload', requiredCapability: 'harniverse.administer' }) async reload(): Promise<void>
```

Source: [`packages/monitor/governor/src/index.ts:121`](../../packages/monitor/governor/src/index.ts)

<a id="governor-events"></a>

### `governor/*` events

<a id="governorbreach--emit"></a>

#### `governor/breach` — emit

One metered command was killed by enforcement. Consumers surface the breach on host-level UI; the session sees it through the tool result.

```ts cordis-catalog
/**
 * One metered command was killed by enforcement. Consumers surface the
 * breach on host-level UI; the session sees it through the tool result.
 * @param event - the recorded breach facts.
 * @mode emit
 */
'governor/breach'(event: GovernorBreachRecord): void
```

Source: [`packages/monitor/governor/src/index.ts:51`](../../packages/monitor/governor/src/index.ts)
<!-- END GENERATED cordis-surface -->
