/**
 * Service Provider for the resource governor (`ctx.governor`): metering of
 * correlated shell/terminal spawns (CPU, memory, disk, network-lite), tiered
 * enforcement (cgroup v2 when writable; prlimit prefix plus a sampler
 * watchdog otherwise; observe-only as the floor), and shared-pool session
 * memory quotas with admission control, durable overrides, and a
 * model-facing `resource-quota` tool. Exposes the `governor` Typert Remote
 * namespace (observe/operate/administer capabilities).
 * @module @deepseek-ai/dsh-governor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionClosedEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubprocessCorrelation, SubprocessHandle, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { CgroupRoot } from './cgroup.ts'
import type { CgroupInternals } from './cgroup.ts'
import type { GovernorConfig } from './types.ts'
import { Config, DEFAULT_CONFIG, resolveGlobalLimitBytes } from './config.ts'
import { MeteringEngine } from './sampler.ts'
import type { TickResult } from './sampler.ts'
import type { CommandView, SamplerOptions } from './types.ts'
import { QuotaBook } from './quota.ts'
import type { QuotaOverrideStore } from './quota.ts'
import type { GovernorBreachRecord, GovernorOverview, HistoryRow, QuotaOverrideRecord, SessionQuotaState } from './types.ts'

/** Settings namespace the `governor:` settings.yaml section resolves against. */
export const GOVERNOR_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('governor')

declare module '@deepseek-ai/cordis' {
  interface Context {
    governor: GovernorService
  }

  interface Events {
    /**
     * One metered command was killed by enforcement. Consumers surface the
     * breach on host-level UI; the session sees it through the tool result.
     * @param event - the recorded breach facts.
     * @mode emit
     */
    'governor/breach'(event: GovernorBreachRecord): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only audit trail of one decided quota (no SurfaceIntent). */
    'governor/quota': {
      sessionId: string
      fromBytes: number | null
      toBytes: number | null
      reason: 'tool' | 'board' | 'resume' | 'clear'
      clamped: boolean
      turn: null
    }
  }
}

const quotaOverrideSchema = z.object({
  sessionId: z.string(),
  memoryBytes: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  reason: z.string(),
})

const historyRowSchema = z.object({
  sessionId: z.string(),
  commandId: z.string(),
  t: z.number().int().nonnegative(),
  cpuTicks: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
  readBytes: z.number().nonnegative(),
  writeBytes: z.number().nonnegative(),
})

/** Durable layout of the governor's storage domain. */
export const governorDomainSpec = defineDomain({
  name: 'governor',
  version: 1,
  migrateFrom: [],
  tables: {
    quota_overrides: domainTable<string, QuotaOverrideRecord>(quotaOverrideSchema),
    history: domainTable<string, HistoryRow>(historyRowSchema),
  },
})

/** Test-only injection points (composition always uses the real ones). */
export interface GovernorInternals {
  readonly cgroup?: CgroupInternals
  readonly sampler?: Partial<SamplerOptions>
}

/** Smallest meaningful raise the tool accepts. */
export const MIN_RAISE_BYTES = 64 * 1024 * 1024

/** The optional quota field of one state projection (shared helper keeps one branch). */
function quotaField(state: SessionQuotaState): { quotaBytes?: number } {
  return state.quotaBytes !== undefined ? { quotaBytes: state.quotaBytes } : {}
}

/** Persistence is best-effort: storage failures surface through the backends. */
/* v8 ignore next 1 -- only reachable on backend write failures. */
function swallowStorageWrite(): void {}

/** Adapter from a storage-domain KV table to the quota book's store shape. */
function overrideStoreOf(table: KvTable<string, QuotaOverrideRecord>): QuotaOverrideStore {
  return {
    entries: () => table.entries(),
    put: (sessionId, record) => table.put(sessionId, record),
    delete: sessionId => table.delete(sessionId),
  }
}

/**
 * The resource governor service. See the package README and the Agent Note
 * (`2026-09-12-resource-governor-metering-and-quotas`) for the tier model,
 * shared-pool semantics, and sandbox-realm integration contract.
 */
export class GovernorService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain']

  private readonly ownerCtx: Context
  private config: GovernorConfig
  private globalLimitBytes = 0
  private book: QuotaBook | undefined
  private engine: MeteringEngine | undefined
  private readonly cgroup: CgroupRoot
  private readonly samplerOptions: Partial<SamplerOptions>
  private tier: 'cgroup' | 'rlimit' | 'observe' = 'observe'
  private overrides: KvTable<string, QuotaOverrideRecord> | undefined
  private history: KvTable<string, HistoryRow> | undefined
  private lastTick: TickResult | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly lastPersistAt = new Map<string, number>()
  private tickCount = 0

  constructor(ctx: Context, config: GovernorConfig = DEFAULT_CONFIG, internals: GovernorInternals = {}) {
    super(ctx, 'governor')
    this.ownerCtx = ctx
    this.config = config
    this.cgroup = new CgroupRoot('/sys/fs/cgroup', internals.cgroup)
    this.samplerOptions = internals.sampler ?? {}
    installSettingsSection(this.ctx, GOVERNOR_SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        this.config = current()
      },
      onChange: () => {
        void this.applyGlobalLimit()
      },
    })
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(governorDomainSpec)
    this.overrides = domain.table('quota_overrides')
    this.history = domain.table('history')
    // The constructor's placeholder book resolves nothing before this swap;
    // seeding the budget first gives its getter the same one honest read.
    this.book = new QuotaBook(() => this.globalLimitBytes, overrideStoreOf(this.overrides))
    this.engine = new MeteringEngine({
      effectiveLimitBytes: sessionId => this.requireBook().effectiveLimitBytes(sessionId),
      globalLimitBytes: () => this.globalLimitBytes,
      ...this.samplerOptions,
    })
    this.ownerCtx.effect(() => async () => {
      this.closed = true
      this.disarm()
      await domain.close()
    }, 'governor lifecycle')

    await this.applyGlobalLimit()
    this.requireBook().load()
    this.tier = await this.cgroup.probe() ? 'cgroup' : 'rlimit'
    await this.cgroup.sweep()

    this.ctx.on('subprocess/spawned', ({ correlation, handle }) => { this.onSpawned(correlation, handle) })
    this.ctx.on('subprocess/terminal-spawned', ({ correlation, handle }) => { this.onSpawned(correlation, handle) })
    this.ctx.on('subprocess/exited', ({ correlation }) => { this.requireEngine().settle(correlation.commandId) })
    this.ctx.on('subprocess/terminal-exited', ({ correlation }) => { this.requireEngine().settle(correlation.commandId) })

    this.registerTools()
    this.ctx.on('session/created', (session) => { void this.onSessionCreated(session) })
    // Explicit closes drop the override; teardown cascades (session/disposed)
    // must NOT — quota decisions survive host restarts by design, and the
    // abandoned-row TTL sweep collects sessions that never close cleanly.
    this.ctx.on('session/closed', (event) => { void this.onSessionClosed(event) })
    // HMR does not replay session/created — sweep the store once.
    for (const session of this.ctx.sessions.list()) void this.onSessionCreated(session)

    this.rearm(this.config.sampling.baseMs)
  }

  /** The store-backed book; every caller runs after Service.init completed. */
  private requireBook(): QuotaBook {
    if (this.book === undefined) throw new Error('governor: quota book used before Service.init')
    return this.book
  }

  /** The sampling engine; every caller runs after Service.init completed. */
  private requireEngine(): MeteringEngine {
    if (this.engine === undefined) throw new Error('governor: metering engine used before Service.init')
    return this.engine
  }

  /** Resolve the effective settings and (re)apply the global budget. */
  private async applyGlobalLimit(): Promise<void> {
    this.globalLimitBytes = await resolveGlobalLimitBytes(this.config)
    await this.cgroup.ensureParent(this.globalLimitBytes)
    // Settings attach can fire this before Service.init builds the book; the
    // leaf pass then simply waits for the init-time re-application.
    for (const [sessionId, record] of this.book?.entries() ?? []) {
      await this.cgroup.ensureSession(sessionId, record.memoryBytes)
    }
  }

  /** Track one metered spawn; attach it to the enforcement tier. */
  private onSpawned(correlation: SubprocessCorrelation, handle: SubprocessHandle | SubprocessTerminalHandle): void {
    this.requireEngine().track(correlation.commandId, correlation.sessionId, correlation.kind, handle)
    if (this.tier === 'cgroup' && handle.pid > 0) {
      const leafSession = this.requireBook().override(correlation.sessionId) === undefined
        ? undefined
        : correlation.sessionId
      void this.cgroup.attach(handle.pid, leafSession)
    }
  }

  /** Resume replay: re-admit a persisted override, clamping notifies the agent. */
  private async onSessionCreated(session: Session): Promise<void> {
    const record = this.requireBook().override(session.id)
    if (record === undefined) return
    const { grantedBytes, clamped } = this.requireBook().admit(session.id, record.memoryBytes)
    await this.requireBook().commit(session.id, grantedBytes, clamped ? 'resume-clamped' : record.reason)
    await this.cgroup.ensureSession(session.id, grantedBytes)
    this.appendQuotaEvent(session, record.memoryBytes, grantedBytes, 'resume', clamped)
    if (clamped) {
      const agent = this.ctx.agents.get(session.id)
      agent?.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `The session memory quota was re-admitted at ${grantedBytes} bytes after restart (previously ${record.memoryBytes}); other sessions claimed part of the global budget in the meantime.`,
        }],
        source: { kind: 'plugin', plugin: 'governor' },
      }))
    }
  }

  /** A session closed deliberately: drop its override and enforcement leaf. */
  private async onSessionClosed(event: SessionClosedEvent): Promise<void> {
    // A late delivery after the domain closed leaves the row for the TTL sweep.
    /* v8 ignore next 1 -- the catch only swallows the teardown race where the
       storage domain has already closed; drive-by coverage cannot time it. */
    await this.requireBook().clear(event.sessionId).catch(() => {})
    await this.cgroup.cleanupSession(event.sessionId)
  }

  /** Arm the next sampling tick at the adaptive cadence. */
  private rearm(delayMs: number): void {
    if (this.closed) return
    this.disarm()
    const timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
    timer.unref()
    this.timer = timer
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** One sampling tick: meter, persist opt-in history, judge overages. */
  private async tick(): Promise<void> {
    if (this.closed) return
    this.tickCount += 1
    const result = await this.requireEngine().tick()
    this.lastTick = result
    if (this.config.history.persist && this.history !== undefined) {
      const t = result.t
      for (const view of this.requireEngine().liveViews()) {
        const last = this.lastPersistAt.get(view.commandId) ?? 0
        if (t - last < this.config.history.resolutionMs) continue
        const sample = view.samples[view.samples.length - 1]
        /* v8 ignore next 2 -- fold appends one sample per tick, so a live view
           always carries at least one sample; the guard only narrows the index type. */
        if (sample === undefined) continue
        this.lastPersistAt.set(view.commandId, t)
        await this.history.put(`${view.sessionId}|${view.commandId}|${t}`, {
          sessionId: view.sessionId,
          commandId: view.commandId,
          t,
          cpuTicks: sample.cpuTicks,
          rssBytes: sample.rssBytes,
          readBytes: sample.readBytes,
          writeBytes: sample.writeBytes,
        }).catch(swallowStorageWrite)
      }
    }
    this.enforceOverages(result)
    if (this.tickCount % 120 === 0) await this.sweep()
    const hot = result.sessionRss.size > 0 && [...result.sessionRss.entries()]
      .some(([sessionId, rss]) => rss > this.requireBook().effectiveLimitBytes(sessionId) * 0.7)
    this.rearm(hot ? this.config.sampling.hotMs : this.config.sampling.baseMs)
  }

  /** Watchdog tier: kill the largest offending command per sustained overage. */
  private enforceOverages(result: TickResult): void {
    if (result.overages.length === 0) return
    const views = this.requireEngine().liveViews()
    for (const overage of result.overages) {
      const candidates = views.filter(view => overage.scope === 'global' || view.sessionId === overage.sessionId)
      let target: (typeof candidates)[number] | undefined
      for (const view of candidates) {
        if (target === undefined || view.peakRssBytes > target.peakRssBytes) target = view
      }
      /* v8 ignore next 3 -- an overage derives from live commands in this very
         tick, so candidates cannot be empty; the guard only narrows the type. */
      if (target === undefined) continue
      const liveSample = Math.max(
        target.peakRssBytes,
        target.samples.reduce((max, sample) => Math.max(max, sample.rssBytes), 0),
      )
      const breach: GovernorBreachRecord = {
        kind: overage.scope === 'global' ? 'memory-limit' : 'session-quota',
        sessionId: target.sessionId,
        commandId: target.commandId,
        peakBytes: Math.max(target.peakRssBytes, liveSample),
        limitBytes: overage.limitBytes,
        at: result.t,
      }
      this.requireEngine().recordBreach(breach)
      this.requireEngine().terminate(target.commandId)
      this.ctx.emit('governor/breach', breach)
    }
  }

  /** Retention and abandoned-override sweep (periodic, cheap). */
  private async sweep(): Promise<void> {
    const cutoff = (this.lastTick?.t ?? Date.now()) - this.config.history.retentionMs
    if (this.history !== undefined) {
      for (const [key, row] of [...this.history.entries()]) {
        if (row.t < cutoff) await this.history.delete(key).catch(swallowStorageWrite)
      }
    }
    await this.requireBook().sweepAbandoned(Date.now(), this.config.history.retentionMs)
  }

  /**
   * Spawn bounds for one session — the tool-bash collaboration seam. Every
   * metered command carries its session's effective limit: an explicit quota
   * for leaf sessions, the shared global budget for pool members.
   * @param sessionId - session id.
   * @returns the limits the provider should enforce.
   */
  limitsFor(sessionId: string): { maxMemoryBytes?: number } | undefined {
    return { maxMemoryBytes: this.requireBook().effectiveLimitBytes(sessionId) }
  }

  /**
   * Breach facts for one command — the tool-bash result-merge seam.
   * @param commandId - command id.
   * @returns the recorded breach when one exists.
   */
  breachFor(commandId: string): GovernorBreachRecord | undefined {
    return this.requireEngine().breachFor(commandId)
  }

  /** Append the log-only quota audit event. */
  private appendQuotaEvent(
    session: Session,
    fromBytes: number | null,
    toBytes: number | null,
    reason: 'tool' | 'board' | 'resume' | 'clear',
    clamped: boolean,
  ): void {
    session.append('governor/quota', {
      sessionId: session.id,
      fromBytes,
      toBytes,
      reason,
      clamped,
      turn: null,
    })
  }

  /**
   * Effective quota state for one session.
   * @param sessionId - session id.
   * @returns the explicit quota (when set), effective limit, and pool membership.
   */
  quotaStateOf(sessionId: string): SessionQuotaState {
    const override = this.requireBook().override(sessionId)
    return {
      sessionId,
      ...override !== undefined ? { quotaBytes: override.memoryBytes } : {},
      effectiveLimitBytes: this.requireBook().effectiveLimitBytes(sessionId),
      shared: this.requireBook().isShared(sessionId),
    }
  }

  /** Assemble the board overview. */
  private overviewOf(): GovernorOverview {
    const sessionRss = this.lastTick?.sessionRss ?? new Map<string, number>()
    const sessionCpu = this.lastTick?.sessionCpuTicks ?? new Map<string, number>()
    const ids = new Set<string>([
      ...sessionRss.keys(),
      ...this.requireBook().sessionIds(),
      ...this.requireEngine().liveViews().map(view => view.sessionId),
    ])
    const rows = [...ids].map(sessionId => ({
      sessionId,
      rssBytes: sessionRss.get(sessionId) ?? 0,
      cpuTicks: sessionCpu.get(sessionId) ?? 0,
      commands: this.requireEngine().viewsOf(sessionId).filter(view => view.exitedAt === undefined).length,
      quota: this.quotaStateOf(sessionId),
      breaches: this.requireEngine().recentBreaches().filter(breach => breach.sessionId === sessionId).slice(0, 10),
    }))
    const liveRssBytes = [...sessionRss.values()].reduce((sum, value) => sum + value, 0)
    return {
      tier: this.tier,
      globalLimitBytes: this.globalLimitBytes,
      liveRssBytes,
      sessions: rows,
      ...this.lastTick !== undefined && this.lastTick.hostFreeBytes !== undefined ? { hostFreeBytes: this.lastTick.hostFreeBytes } : {},
      ...this.lastTick !== undefined && this.lastTick.hostNet !== undefined ? {
        hostNetRxBytes: this.lastTick.hostNet.rxBytes,
        hostNetTxBytes: this.lastTick.hostNet.txBytes,
      } : {},
      t: this.lastTick?.t ?? Date.now(),
    }
  }

  /**
   * Adjust one session's quota (board/HTTP path — operate capability).
   * @param sessionId - session id.
   * @param memoryBytes - explicit quota in bytes, or null to rejoin the pool.
   * @param reason - audit trail origin of the decision.
   * @returns the session's quota state after admission and persistence.
   */
  async adjustQuota(sessionId: string, memoryBytes: number | null, reason: 'board' | 'tool' | 'clear'): Promise<SessionQuotaState> {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`governor: unknown session ${sessionId}`)
    const before = this.requireBook().effectiveLimitBytes(sessionId)
    if (memoryBytes === null) {
      await this.requireBook().clear(sessionId)
      await this.cgroup.cleanupSession(sessionId)
      this.appendQuotaEvent(session, before, null, 'clear', false)
      return this.quotaStateOf(sessionId)
    }
    if (!Number.isInteger(memoryBytes) || memoryBytes <= 0) {
      throw new Error('governor: memoryBytes must be a positive integer')
    }
    const { grantedBytes, clamped } = this.requireBook().admit(sessionId, memoryBytes)
    await this.requireBook().commit(sessionId, grantedBytes, reason)
    await this.cgroup.ensureSession(sessionId, grantedBytes)
    this.appendQuotaEvent(session, before, grantedBytes, reason, clamped)
    return this.quotaStateOf(sessionId)
  }

  /**
   * Board overview (`harniverse.observe`).
   * @returns tier, global budget usage, per-session rows, and host sentinels.
   */
  @Remote({ exportName: 'overview', requiredCapability: 'harniverse.observe' })
  overview(): GovernorOverview {
    return this.overviewOf()
  }

  /**
   * Per-session command views (`harniverse.observe`).
   * @param sessionId - session id.
   * @returns live commands first, then settled ones, with sample rings.
   */
  @Remote({ exportName: 'sessionSamples', requiredCapability: 'harniverse.observe' })
  sessionSamples(sessionId: string): CommandView[] {
    return this.requireEngine().viewsOf(sessionId)
  }

  /**
   * Read one session's quota state (`harniverse.observe`).
   * @param sessionId - session id.
   * @returns the explicit quota, effective limit, and pool membership.
   */
  @Remote({ exportName: 'sessionQuotaGet', requiredCapability: 'harniverse.observe' })
  sessionQuotaGet(sessionId: string): SessionQuotaState {
    return this.quotaStateOf(sessionId)
  }

  /**
   * Adjust one session's quota (`harniverse.operate`).
   * @param sessionId - session id.
   * @param memoryBytes - explicit quota in bytes, or null to rejoin the pool.
   * @returns the session's quota state after admission and persistence.
   */
  @Remote({ exportName: 'sessionQuotaAdjust', requiredCapability: 'harniverse.operate' })
  async sessionQuotaAdjust(sessionId: string, memoryBytes: number | null): Promise<SessionQuotaState> {
    return this.adjustQuota(sessionId, memoryBytes, 'board')
  }

  /**
   * Breach history, newest first (`harniverse.observe`).
   * @returns the bounded breach list.
   */
  @Remote({ exportName: 'breaches', requiredCapability: 'harniverse.observe' })
  breaches(): readonly GovernorBreachRecord[] {
    return this.requireEngine().recentBreaches()
  }

  /**
   * Effective settings plus the resolved budget (`harniverse.observe`).
   * @returns the config with `globalLimitBytes` attached.
   */
  @Remote({ exportName: 'configGet', requiredCapability: 'harniverse.observe' })
  configGet(): GovernorConfig & { globalLimitBytes: number } {
    return { ...this.config, globalLimitBytes: this.globalLimitBytes }
  }

  /** Re-resolve settings and re-apply the global budget (`harniverse.administer`). */
  @Remote({ exportName: 'reload', requiredCapability: 'harniverse.administer' })
  async reload(): Promise<void> {
    await this.applyGlobalLimit()
  }

  /** Register the model-facing quota tool (mounted when `ctx.tools` exists). */
  private registerTools(): void {
    this.ctx.inject(['tools'], (scope: Context) => {
      scope.effect(() => scope.tools.register(defineTool({
        name: 'resource-quota',
        description: 'Read or negotiate the memory quota of YOUR current session. Get returns the effective limit, the global budget, and current usage. Set with memoryBytes to request a different explicit quota (must exceed 64MiB to be meaningful); omit memoryBytes to drop the explicit quota and rejoin the shared pool. Raises may require user approval and are always clamped by the remaining global budget. This tool cannot touch other sessions or the global budget.',
        parameters: {
          action: { type: 'string', required: true, enum: ['get', 'set'], description: 'get reads the quota state; set negotiates a change.' },
          memoryBytes: { type: 'number', description: 'With action=set: the explicit memory quota in bytes. Omit to clear the explicit quota and rejoin the shared pool.' },
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'state' },
                  sessionId: { type: 'string', required: true },
                  quotaBytes: { type: 'number' },
                  effectiveLimitBytes: { type: 'number', required: true },
                  globalLimitBytes: { type: 'number', required: true },
                  shared: { type: 'boolean', required: true },
                  clamped: { type: 'boolean' },
                  liveRssBytes: { type: 'number', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'rejected' },
                  reason: { type: 'string', required: true },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'rejected'
              ? `quota request rejected: ${value.reason}`
              : `session ${value.sessionId} memory quota: ${value.shared ? 'shared pool' : `${String(value.quotaBytes)} bytes`}`
                + `, effective limit ${String(value.effectiveLimitBytes)} bytes, global budget ${String(value.globalLimitBytes)} bytes`
                + (value.clamped === true ? ' (clamped to the remaining budget)' : ''),
          }],
          presentationMeta: (_args, value) => value,
        },
        execute: async (args: { action: string; memoryBytes?: number }, exec: ToolExecution) => {
          const agent = exec.agent
          if (agent === undefined) throw new Error('resource-quota requires a session context')
          const sessionId = agent.session.id
          if (args.action === 'get') {
            const state = this.quotaStateOf(sessionId)
            return {
              kind: 'state' as const,
              sessionId,
              ...quotaField(state),
              effectiveLimitBytes: state.effectiveLimitBytes,
              globalLimitBytes: this.globalLimitBytes,
              shared: state.shared,
              liveRssBytes: this.lastTick?.sessionRss.get(sessionId) ?? 0,
            }
          }
          if (args.memoryBytes === undefined) {
            const state = await this.adjustQuota(sessionId, null, 'clear')
            return this.toolState(sessionId, state, false)
          }
          if (!Number.isFinite(args.memoryBytes) || args.memoryBytes <= 0) {
            throw new Error('memoryBytes must be a positive number')
          }
          const before = this.requireBook().effectiveLimitBytes(sessionId)
          const { grantedBytes, clamped } = this.requireBook().admit(sessionId, args.memoryBytes)
          const raise = grantedBytes > before
          if (raise && grantedBytes < MIN_RAISE_BYTES) {
            return { kind: 'rejected' as const, reason: `the raise is below the ${MIN_RAISE_BYTES}-byte minimum a quota is meaningful at` }
          }
          if (raise && !await this.approveRaise(scope, agent, exec, before, grantedBytes)) {
            return { kind: 'rejected' as const, reason: 'the quota raise was not approved' }
          }
          const state = await this.adjustQuota(sessionId, grantedBytes, 'tool')
          return this.toolState(sessionId, state, clamped)
        },
      })), 'governor: resource-quota tool')
    })
  }

  /**
   * Ask for approval on one raise under an `ask` policy; `never` (the
   * danger-full-access posture) proceeds — admission still clamps, and a
   * missing approval service means no gate is configured.
   */
  private async approveRaise(scope: Context, agent: ToolExecution['agent'], exec: ToolExecution, before: number, grantedBytes: number): Promise<boolean> {
    const approval = scope.get('approval') as {
      effectivePolicy(session: Session): 'ask' | 'never'
      request(req: { agent: unknown; toolName: string; callId?: string; reason: string; signal?: AbortSignal }): Promise<string>
    } | undefined
    /* v8 ignore next 2 -- the tool execute rejects an agent-less call before
       reaching the raise gate, so `agent === undefined` is unreachable here. */
    if (approval === undefined || agent === undefined || approval.effectivePolicy(agent.session) === 'never') return true
    const outcome = await approval.request({
      agent,
      toolName: 'resource-quota',
      callId: exec.callId,
      reason: `raise the session memory quota from ${before} to ${grantedBytes} bytes`,
      signal: exec.signal,
    })
    return outcome === 'allowed-once'
  }

  /** Common shape of tool state results. */
  private toolState(sessionId: string, state: SessionQuotaState, clamped: boolean): {
    kind: 'state'
    sessionId: string
    quotaBytes?: number
    effectiveLimitBytes: number
    globalLimitBytes: number
    shared: boolean
    clamped: boolean
    liveRssBytes: number
  } {
    return {
      kind: 'state' as const,
      sessionId,
      ...quotaField(state),
      effectiveLimitBytes: state.effectiveLimitBytes,
      globalLimitBytes: this.globalLimitBytes,
      shared: state.shared,
      clamped,
      liveRssBytes: this.lastTick?.sessionRss.get(sessionId) ?? 0,
    }
  }
}

export default GovernorService
