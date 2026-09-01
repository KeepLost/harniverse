/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
 *
 * Unlike the bash seam (one executor per context, second load throws), MULTIPLE
 * providers coexist here: each registers under a unique name and a caller picks
 * one by name. The shape mirrors the LLM adapter registry
 * (`LlmRuntime.registerAdapter`), not the single-service bash executor.
 *
 * This package owns the Service Definition role of the capability seam. Service Providers
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * Public operations express caller intent: `start` is a deprecated legacy
 * one-shot operation, `startContinuable` establishes a durable child, and
 * `followup` delivers later content without exposing whether the child is
 * resident. Continuable children never become a {@link SubagentRun}: the
 * continuation manager holds their `AgentHandle` directly and orders every turn
 * through the child's own inbox, so providers contribute only the detached
 * creation spec and see no handle, turn, or teardown. Child and descendant
 * discovery read the live session store and optional session persistence
 * directly and do not require that continuation runtime.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-supervision'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ChildModelRoute,
  ChildModelRouteTarget,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentInvocation,
  SubagentInvocationMode,
  SubagentProvider,
  SubagentRun,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentStartRequest,
} from './types.ts'
import type { ChildProfileGrant, ChildProfileSetup, ChildProfileSpec, ResolvedChildProfile } from './types.ts'
import { SubagentInvocationId } from './types.ts'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { createActivationObserver, createLifecycleEmitter, observeRun } from './lifecycle.ts'
import type { ActivationObserver, LifecycleEmitter } from './lifecycle.ts'
import SubagentContinuationManager from './continuation.ts'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentReportOptions,
} from './continuation.ts'
import SubagentActivationSetupRegistry from './activation-setup-registry.ts'
import type { ContinuableSetupContribution } from './activation-setup-registry.ts'
import { listChildren as listSubagentChildren, listDescendants as listSubagentDescendants } from './list-children.ts'
import type { SubagentDescendantListEntry, SubagentListEntry } from './list-children.ts'
import { snapshotSubagentDescriptor } from './descriptor.ts'
import { assertResolvedChildProfile, childProfileToolFilter, resolveChildProfile } from './profile.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition } from './projection.ts'

export * from './out-of-process.ts'
export { AssistantOutputFold, finalAssistantOutput } from './assistant-output.ts'
export { SubagentInvocationId, SubagentRunId } from './types.ts'
export type {
  ChildProfileGrant,
  ChildProfileSpec,
  ResolvedChildProfile,
  ChildModelRoute,
  ChildModelRouteTarget,
  ChildProfileSetup,
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentInvocation,
  SubagentInvocationMode,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  assertResolvedChildProfile,
  childProfileToolFilter,
  isWorkspaceDescendant,
  parseResolvedChildProfile,
  resolveChildProfile,
} from './profile.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type {
  ContinuableSubagentDescriptorData,
  ContinuableSubagentDescriptorInput,
  OneShotSubagentDescriptorData,
  OneShotSubagentDescriptorInput,
  SubagentDescriptorData,
  SubagentDescriptorInput,
} from './descriptor.ts'
export { seedDescriptorTurn } from './descriptor-seed.ts'
export { SubagentError } from './error.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
export type {
  ContinuableStart,
  ContinuableStartSpec,
  CoordinatorMessageSource,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentReportDelivery,
  SubagentReportMessageSource,
  SubagentReportOptions,
  SubagentSettledMessageSource,
} from './continuation.ts'
export type { ContinuableSetupContribution } from './activation-setup-registry.ts'
export type { SubagentDescendantListEntry, SubagentListEntry } from './list-children.ts'
export type { SubagentRunEndInfo, SubagentRunInfo } from './types.ts'
export type { SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a published child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the delegating parent, so a
     * parent-scoped listener observes only its own delegations. Paired with
     * `subagent/end`.
     * @param info - the provider and published child identity.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * A published child settled. Scope-filtered dispatch uses the same delegating
     * parent carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - the run identity and terminal outcome.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

/** Named provider registry with deprecated one-shot support and durable child operations. */
export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
  private readonly profileGrants = new WeakMap<Agent, ChildProfileGrant>()
  private readonly profiles = new WeakMap<Agent, Map<string, ResolvedChildProfile>>()
  private readonly modelRoutes = new Map<string, ChildModelRoute>()
  private readonly profileSetups = new Set<ChildProfileSetup>()
  private readonly profilePriorities = new WeakMap<Agent, number>()
  private readonly activeProfileAgents = new Map<Agent, number>()
  private readonly priorityWaiters = new Set<() => void>()
  private continuations: SubagentContinuationManager | undefined
  /** Deployment contributions composed into unpublished continuable children. */
  private readonly setupRegistry = new SubagentActivationSetupRegistry()
  /**
   * The contained lifecycle-edge publisher. Built here because scoped dispatch
   * keys its carrier by this exact service instance, whose own context filter
   * composes into the carrier.
   */
  private readonly emitLifecycle: LifecycleEmitter

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
    ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: 'idle' | 'running' }) => {
      if (!this.profilePriorities.has(agent)) return
      if (status === 'running') this.activeProfileAgents.set(agent, this.profilePriorities.get(agent) as number)
      else this.activeProfileAgents.delete(agent)
      for (const wake of this.priorityWaiters) wake()
    })
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(childCtx, {
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        supportsChildProfile: name => this.supportsChildProfile(name),
        resolveChildModelRoute: profile => this.resolveChildModelRoute(profile),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
      }, this.setupRegistry)
      this.continuations = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition)
    })
  }

  /**
   * Establish one durable continuable child and deliver its initial prompt.
   * Resolves when the child's inbox accepts that prompt, without waiting for the
   * turn to start or for the message to reach the Session log; any earlier
   * failure rejects with no ids and rolls back the child entirely.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id, accepted prompt message id, and initial
   *   Activation result promise.
   * @throws when continuation services are unavailable or materialization fails.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    return this.requireContinuations().startContinuable(spec)
  }

  /**
   * Deliver one later message to a continuable child as its next FIFO turn. A
   * resident child's Agent inbox accepts it directly (waking a `waiting`
   * Activation), while an absent one is cold-resumed from its persisted
   * Session. The Agent inbox is the only queue, so every accepted message has
   * one observable order.
   * @param parent - the exact live direct parent authorizing this delivery.
   * @param childId - durable child session id.
   * @param content - user-role content to deliver.
   * @param options - the message source fields and caller cancellation, which stops the
   *   operation only before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when continuation services are unavailable, parent authority is
   *   rejected, or the message was not admitted.
   */
  async followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().followup(parent, childId, content, options)
  }

  /**
   * Interrupt one live continuable child's current turn under a human parent
   * address or an exact live ancestor Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted driver is idle, a waking send resumes the parked FIFO
   * queue. An absent target — including a one-shot or unknown id —
   * is an accepted no-op, as is a manager-less composition, which cannot own a
   * live Activation.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
   *   live target.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.continuations?.interrupt(targetSessionId, authority)
  }

  /**
   * Deliver selected content from one live continuable child to its durable
   * direct parent. The child is the authority credential; callers cannot name a
   * recipient. Reporting does not conclude the child's turn or Activation.
   * @param child - exact live reporting child.
   * @param content - selected model-facing content.
   * @param options - parent scheduling and pre-acceptance cancellation.
   * @returns the stable identity of the parent-accepted message.
   * @throws when continuation services are unavailable, sender authorization
   *   fails, or the direct parent is not live.
   */
  async reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: SubagentReportOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().reportFrom(child, content, options)
  }

  /**
   * Compose one deployment capability into every continuable child's
   * unpublished creation context on fresh creation and cold resume. Grants wait
   * for the next Activation; removing the contribution revokes every resident
   * installation immediately.
   * @param contribution - synchronous child-scope installer.
   * @returns the exact Cordis effect disposer.
   */
  registerContinuableSetup(contribution: ContinuableSetupContribution): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(
      () => this.setupRegistry.register(contribution),
      'subagents.registerContinuableSetup()',
    )
  }

  /**
   * Close continuable admission below exact live parent Agents, stop only their
   * visible descendant Activations synchronously, then await admitted scoped
   * materializations and release those forests child-first. The scoped cutoff
   * lasts until each exact parent leaves the registry; unrelated parent trees
   * remain live.
   * @param parents - exact host-owned parent Agents entering teardown.
   * @returns once every retained descendant Activation released its `AgentHandle`.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.continuations
    // Absent continuation services means nothing was ever materialized.
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * Enumerate the parent's direct session-backed subagents without loading or
   * resuming an Agent and without any query service: the listing merges the live
   * session store with optional session persistence (live-preferred) and
   * serves each child's durable mode/label from the registered `subagent`
   * projection unit down a three-rung ladder — the registry's watermark
   * snapshot for a live child; for a cold one, a durable projection-cache
   * row when the optional cache serves an own-suffix identity (its `seq`
   * gate proves the value postdates the fork seed, where a child's own
   * descriptor is immutable once appended), else one persistence inspection
   * folded through the registry. The
   * projection fold is the single classification authority; per-child
   * diagnostics relay a fold that served no identity or a failed inspection,
   * never a list-time descriptor parse. Absent persistence, enumeration is
   * live-only (a cold child cannot be resumed then either, so its absence is
   * capability absence, not an error). This service consults no Agent
   * registrations, Activations, or providers.
   *
   * Every persistence read receives `signal`, and the listing rechecks
   * cancellation around each of those awaits. Read rejections that settle
   * after an abort become a stable `SubagentError` with code `CANCELLED`.
   * @param parentSessionId - parent session whose direct children are listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-child diagnostics ordered by `createdAt`, then id.
   * @throws {@link SubagentError} when the projection registry or the session
   *   store is not mounted, or the caller cancels the listing.
   */
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]> {
    return listSubagentChildren(this.ctx, parentSessionId, signal)
  }

  /**
   * Enumerate the root's complete session-backed subagent tree in stable
   * pre-order from one live-preferred corpus, without loading or resuming an
   * Agent. Ordinary sessions and one-shot children remain traversal nodes so
   * continuable descendants below them are discovered; each returned entry
   * adds its durable `parentId` and root-relative `depth`. Identity resolution,
   * diagnostics, optional persistence, and cancellation follow the same
   * projection-backed contract as {@link listChildren}.
   * @param rootSessionId - session whose complete descendant tree is listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-candidate diagnostics with tree position, in
   *   stable pre-order.
   * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Bind the Host-computed capability grant to one exact live parent. A model
   * cannot supply or mutate the grant; a scoped management Consumer may project
   * its detached snapshot for Profile authoring.
   * @param parent - exact parent Agent receiving the private grant.
   * @param grant - host-owned capabilities available to child profiles.
   * @returns an effect disposer that revokes this exact binding.
   */
  registerChildProfileGrant(parent: Agent, grant: ChildProfileGrant): () => void {
    if (this.profileGrants.has(parent)) {
      throw new SubagentError(`a child profile grant is already bound to parent "${parent.id}"`, 'DUPLICATE_PROFILE_GRANT')
    }
    const detached = Object.freeze({
      ...grant,
      harnessIds: Object.freeze([...grant.harnessIds]),
      modelRouteIds: Object.freeze([...grant.modelRouteIds]),
      tools: Object.freeze([...grant.tools]),
      skills: Object.freeze([...grant.skills]),
      mcpServerIds: Object.freeze([...grant.mcpServerIds]),
      childProfileIds: Object.freeze([...grant.childProfileIds]),
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup preserves Cordis disposer identity.
    return this.ctx.effect(function* (this: SubagentRuntime) {
      this.profileGrants.set(parent, detached)
      yield () => {
        if (this.profileGrants.get(parent) === detached) this.profileGrants.delete(parent)
      }
    }.bind(this), 'subagents.registerChildProfileGrant()')
  }

  /**
   * Define or revise one parent-private profile from the parent's Host grant.
   * @param parent - exact live Agent that owns the private namespace.
   * @param spec - complete requested profile specification.
   * @returns the detached immutable resolved revision.
   */
  defineChildProfile(parent: Agent, spec: ChildProfileSpec): ResolvedChildProfile {
    const grant = this.profileGrants.get(parent)
    if (grant === undefined) {
      throw new SubagentError(`no child profile grant is bound to parent "${parent.id}"`, 'PROFILE_GRANT_UNAVAILABLE')
    }
    let profiles = this.profiles.get(parent)
    if (profiles === undefined) {
      profiles = new Map()
      this.profiles.set(parent, profiles)
    }
    const previous = profiles.get(spec.profileId)
    const profile = resolveChildProfile(spec, grant, (previous?.revision ?? 0) + 1)
    if (parent.ctx.get('supervision')?.modeOf(parent.session) === 'unsupervised' && profile.supervisionMode !== 'unsupervised') {
      throw new SubagentError(
        'an unsupervised parent may only define an unsupervised child profile',
        'SUPERVISION_MODE_ESCALATION')
    }
    profiles.set(profile.profileId, profile)
    return profile
  }

  /**
   * List only the exact parent's private resolved profile snapshots.
   * @param parent - exact live Agent that owns the private namespace.
   * @returns current resolved revisions in definition order.
   */
  listChildProfiles(parent: Agent): ResolvedChildProfile[] {
    return [...(this.profiles.get(parent)?.values() ?? [])]
  }

  /**
   * Whether the Host has already bound a private-profile grant to this Agent.
   * @param parent - exact live Agent to inspect.
   * @returns whether that Agent has a bound grant.
   */
  hasChildProfileGrant(parent: Agent): boolean {
    return this.profileGrants.has(parent)
  }

  /**
   * Read the detached grant so a scoped management tool can reuse its defaults.
   * @param parent - exact live Agent to inspect.
   * @returns the detached grant, or `undefined` when none is bound.
   */
  getChildProfileGrant(parent: Agent): ChildProfileGrant | undefined {
    return this.profileGrants.get(parent)
  }

  /**
   * Resolve one profile id from the exact parent's private namespace.
   * @param parent - exact live Agent that owns the namespace.
   * @param profileId - opaque private Profile id.
   * @returns the current immutable revision, or `undefined` when absent.
   */
  getChildProfile(parent: Agent, profileId: string): ResolvedChildProfile | undefined {
    return this.profiles.get(parent)?.get(profileId)
  }

  /**
   * Register one Host-owned opaque model route used by resolved profiles.
   * @param routeId - opaque route identity exposed through grants.
   * @param route - Host-owned primary and fallback model selections.
   * @returns an effect disposer that revokes this exact route.
   */
  registerChildModelRoute(routeId: string, route: ChildModelRoute): () => void {
    if (this.modelRoutes.has(routeId)) {
      throw new SubagentError(`a child model route named "${routeId}" is already registered`, 'DUPLICATE_PROFILE_ROUTE')
    }
    const fallbacks: ChildModelRouteTarget[] = (route.fallbacks ?? []).map(target => Object.freeze({
      provider: target.provider,
      model: target.model,
    }))
    const detached = Object.freeze({
      provider: route.provider,
      model: route.model,
      ...fallbacks.length === 0 ? {} : { fallbacks: Object.freeze(fallbacks) },
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup preserves Cordis disposer identity.
    return this.ctx.effect(function* (this: SubagentRuntime) {
      this.modelRoutes.set(routeId, detached)
      yield () => {
        if (this.modelRoutes.get(routeId) === detached) this.modelRoutes.delete(routeId)
      }
    }.bind(this), 'subagents.registerChildModelRoute()')
  }

  /**
   * Install one idempotent route for a deployment-derived parent default.
   * @param routeId - deterministic route identity.
   * @param route - Host-owned primary selection; an existing matching route keeps its fallback chain.
   */
  ensureChildModelRoute(routeId: string, route: ChildModelRoute): void {
    const existing = this.modelRoutes.get(routeId)
    if (existing !== undefined) {
      if (existing.provider !== route.provider || existing.model !== route.model) {
        throw new SubagentError(`child model route "${routeId}" is bound to a different model`, 'DUPLICATE_PROFILE_ROUTE')
      }
      return
    }
    this.modelRoutes.set(routeId, Object.freeze({
      provider: route.provider,
      model: route.model,
      ...route.fallbacks === undefined ? {} : { fallbacks: Object.freeze([...route.fallbacks]) },
    }))
  }

  /**
   * Resolve a Profile route into the only model selection fields an Agent accepts.
   * @param profile - immutable resolved Profile carrying the opaque route id.
   * @returns the primary Agent model selection with the Profile token ceiling.
   */
  resolveChildModelRoute(profile: ResolvedChildProfile): AgentOptions {
    return this.routeAttempts(profile)[0] as AgentOptions
  }

  /** Resolve the primary route and its Host-owned ordered fallback attempts. */
  private routeAttempts(profile: ResolvedChildProfile): Array<{ provider: string; model: string; maxTokens?: number }> {
    const route = this.modelRoutes.get(profile.modelRouteId) ?? defaultParentRoute(profile.modelRouteId)
    if (route === undefined) {
      throw new SubagentError(`no child model route is registered for "${profile.modelRouteId}"`, 'PROFILE_ROUTE_UNAVAILABLE')
    }
    return [route, ...(route.fallbacks ?? [])].map(target => ({
      provider: target.provider,
      model: target.model,
      ...profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {},
    }))
  }

  /**
   * Register a trusted scoped contribution for Profile Skill/MCP integrations.
   * @param setup - synchronous contribution installed before child publication.
   * @returns an effect disposer that revokes future installations.
   */
  registerChildProfileSetup(setup: ChildProfileSetup): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup preserves Cordis disposer identity.
    return this.ctx.effect(() => {
      this.profileSetups.add(setup)
      return () => { this.profileSetups.delete(setup) }
    }, 'subagents.registerChildProfileSetup()')
  }

  /**
   * Apply all registered Profile contributions during child creation.
   * @param childCtx - unpublished child scope receiving the resolved policy.
   * @param profile - immutable Profile snapshot selected for this child.
   */
  applyChildProfileSetup(childCtx: Context, profile: ResolvedChildProfile): void {
    for (const setup of this.profileSetups) setup(childCtx, profile)
    const child = childCtx.agent
    if (child !== undefined && profile.schedulerPriority !== undefined) {
      this.profilePriorities.set(child, profile.schedulerPriority)
      childCtx.effect(() => () => {
        this.profilePriorities.delete(child)
        this.activeProfileAgents.delete(child)
        for (const wake of this.priorityWaiters) wake()
      }, 'subagents.childProfileSchedulerPriority()')
      childCtx.on('agent/pre-step', async ({ agent }: { agent: Agent }, next) => {
        await this.waitForHigherPriority(agent)
        return next()
      })
    }
    if (child !== undefined) this.installRouteFallback(childCtx, profile)
    if (child !== undefined && !this.profileGrants.has(child)) {
      const revoke = this.registerChildProfileGrant(child, {
        harnessIds: [profile.harnessId],
        modelRouteIds: [profile.modelRouteId],
        tools: profile.tools,
        skills: profile.skills,
        mcpServerIds: profile.mcpServerIds,
        childProfileIds: profile.childProfileIds,
        workspaceRoot: profile.workspaceCwd,
        parentWorkspaceCwd: profile.workspaceCwd,
        ...profile.maxDepth !== undefined ? { maxDepth: profile.maxDepth } : {},
        ...profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {},
      })
      childCtx.effect(() => revoke, 'subagents.childProfileGrant()')
    }
    const tools = childCtx.get('tools')
    if (tools !== undefined) {
      const selectedMcp = new Set(profile.mcpServerIds)
      const deniedMcpTools = tools.schemas()
        .map(schema => schema.name)
        .filter(name => name.startsWith('mcp__'))
        .filter(name => !selectedMcp.has(name.slice('mcp__'.length).split('__', 1)[0] ?? ''))
      if (deniedMcpTools.length > 0) tools.restrict({ deny: deniedMcpTools, includeOwn: true })
    }
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- optional lookup avoids a dependency for augmentation.
    const skills = childCtx.get('skills' as never) as { restrict(filter: { allow: readonly string[]; includeOwn: true }): () => void } | undefined
    if (skills !== undefined) skills.restrict({ allow: profile.skills, includeOwn: true })
  }

  /** Hold a lower-priority child at its next step while a higher one runs. */
  private async waitForHigherPriority(agent: Agent): Promise<void> {
    const priority = this.profilePriorities.get(agent)
    if (priority === undefined) return
    while ([...this.activeProfileAgents].some(([other, active]) => other !== agent && active > priority)) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.priorityWaiters.delete(wake)
          resolve()
        }
        this.priorityWaiters.add(wake)
      })
    }
  }

  /** Install one scoped retry chain so a route failure cannot escape its Profile. */
  private installRouteFallback(childCtx: Context, profile: ResolvedChildProfile): void {
    const attempts = this.routeAttempts(profile)
    if (attempts.length < 2) return
    const attemptByStep = new Map<string, number>()
    childCtx.on('agent/request', async ({ turn, step }: { turn: number; step: number }, next) => {
      const index = attemptByStep.get(`${turn}:${step}`) ?? 0
      const request = await next()
      const route = attempts[index] as { provider: string; model: string; maxTokens?: number }
      return { ...request, provider: route.provider, model: route.model }
    })
    childCtx.on('agent/request-error', async ({ turn, step, provider }: { turn: number; step: number; provider: string }, next) => {
      const key = `${turn}:${step}`
      const index = attemptByStep.get(key) ?? 0
      const current = attempts[index] as { provider: string; model: string; maxTokens?: number }
      if (provider !== current.provider || index + 1 >= attempts.length) return next()
      attemptByStep.set(key, index + 1)
      return { kind: 'retry' as const }
    })
    childCtx.on('agent/turn-stopping', ({ turn }: { turn: number }) => {
      for (const key of attemptByStep.keys()) if (key.startsWith(`${turn}:`)) attemptByStep.delete(key)
    })
  }

  /**
   * Establish a published child on the named provider. This legacy operation
   * returns a provider-owned one-shot run.
   * @deprecated Use {@link startContinuable}; one-shot children are retained
   * only for legacy providers and callers.
   * Capability and semantic
   * checks run before delegation. Provider ownership lasts until its promise
   * fulfills; a rejection therefore has no run for the caller to dispose and
   * emits no run lifecycle events. Post-publication turn and infrastructure
   * failures settle through the returned run.
   * @param name - the provider to use.
   * @param request - child label, prompt, parent, signal, and optional capabilities.
   * @returns the published holder-owned run.
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.expectProvider(name)
    const childProfile = request.childProfile
    this.assertCapabilities(provider, request)
    const effectiveMaxDepth = childProfile?.maxDepth ?? request.maxDepth
    assertSubagentMaxDepth(effectiveMaxDepth)
    if (request.outputSchema !== undefined) assertObjectJsonSchema(request.outputSchema)
    if (childProfile !== undefined) {
      if (provider.supportsChildProfile !== true) {
        throw new SubagentError(
          `subagent provider "${provider.name}" cannot enforce a Child Profile`,
          'UNSUPPORTED_PROFILE',
        )
      }
      assertResolvedChildProfile(childProfile)
      if (childProfile.harnessId !== provider.name) {
        throw new SubagentError(
          `child profile harness "${childProfile.harnessId}" does not match provider "${provider.name}"`,
          'PROFILE_HARNESS_MISMATCH',
        )
      }
      childProfileToolFilter(childProfile, request.toolFilter)
    }
    const descriptor = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: name,
      ...request.label !== undefined ? { label: request.label } : {},
      ...childProfile !== undefined ? { childProfile, maxDepth: effectiveMaxDepth } : {},
    })
    const { childProfile: _requestedProfile, ...requestWithoutProfile } = request
    const resolved: ResolvedSubagentStartRequest = {
      ...requestWithoutProfile,
      ...childProfile !== undefined ? { childProfile } : {},
      ...childProfile !== undefined ? { agentOptions: this.resolveChildModelRoute(childProfile) } : {},
      descriptor,
    }
    // oxlint-disable-next-line typescript/no-deprecated -- this method is the retained compatibility owner for provider one-shot starts.
    return observeRun(this.emitLifecycle, name, request.parent, await provider.start(resolved))
  }

  /**
   * Accept one invocation using the caller's waiting policy. The returned
   * identity always names the durable child Session; provider lifecycle mode
   * remains an implementation detail of this service.
   * @param name - the provider to use.
   * @param mode - whether to await the child result or return after admission.
   * @param request - child label, prompt, parent, signal, and capabilities.
   * @returns the accepted invocation handle with its durable child Session id.
   */
  async invoke<Mode extends SubagentInvocationMode>(
    name: string,
    mode: Mode,
    request: SubagentStartRequest,
  ): Promise<Extract<SubagentInvocation, { readonly mode: Mode }>> {
    if (request.outputSchema !== undefined) {
      throw new SubagentError(
        'subagent invocations cannot request an output schema; inspect the durable child Session instead',
        'UNSUPPORTED_CAPABILITY',
      )
    }
    const { label: _label, signal, outputSchema: _outputSchema, ...continuableRequest } = request
    const started = await this.startContinuable({
      provider: name,
      label: request.label ?? 'subagent invocation',
      request: continuableRequest,
      signal,
    })
    const identity = {
      mode,
      invocationId: SubagentInvocationId(started.messageId),
      sessionId: started.childId,
    }
    if (mode === 'sync') {
      return { ...identity, result: started.result } as Extract<SubagentInvocation, { readonly mode: Mode }>
    }
    return {
      ...identity,
      messageId: started.messageId,
    } as Extract<SubagentInvocation, { readonly mode: Mode }>
  }

  /**
   * Resolve one provider's detached continuable-creation contribution. Method
   * presence on the provider IS the capability, so a provider without it is
   * rejected before the manager reserves any child resources.
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name)
    if (provider.prepareContinuable === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support continuable children `
        + '(no prepareContinuable capability)',
        'UNSUPPORTED_CAPABILITY',
      )
    }
    return provider.prepareContinuable(request)
  }

  /** Report whether a registered provider enforces the resolved profile contract. */
  private supportsChildProfile(name: string): boolean {
    return this.providers.get(name)?.supportsChildProfile === true
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the optional continuable-subagent manager or fail loud. */
  private requireContinuations(): SubagentContinuationManager {
    if (this.continuations === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.continuations
  }

  /**
   * Build the lifecycle observer for one continuable Activation's residency
   * epoch, so the manager publishes its edges without owning event dispatch.
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver {
    return createActivationObserver(this.emitLifecycle, provider, childId, parent)
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

/** Recover a deployment-derived route after a restart from its opaque id. */
function defaultParentRoute(routeId: string): ChildModelRoute | undefined {
  if (!routeId.startsWith('parent:')) return undefined
  const separator = routeId.indexOf(':', 'parent:'.length)
  if (separator === -1) return undefined
  const provider = routeId.slice('parent:'.length, separator)
  const model = routeId.slice(separator + 1)
  return provider === '' || model === '' ? undefined : { provider, model }
}

export default SubagentRuntime
