/** Authorized capability management and native Harness adapters. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent'
import type {
  CapabilityCatalogSnapshot,
  CapabilityCompositionChange,
  CapabilityCompositionSnapshot,
  CapabilityPlan,
  SessionCapabilitySnapshot,
  CapabilityTarget,
  CapabilityView,
} from '@deepseek-ai/dsh-capabilities'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'

export type * from './types.ts'

/** Authorized Remote over static Profile recipes and immutable Session assembly results. */
export class CapabilityManagementGateway extends TypertRemoteService {
  static inject = ['capabilities', 'agentPresets', 'agents', 'subagents']

  constructor(ctx: Context) {
    super(ctx, 'capabilityManagement')
    this.registerAdapters(ctx)
  }

  // capability-remote-anchor

  /**
   * Read one target's capability catalog.
   * @param target - global Agent defaults or one Agent Profile.
   * @returns sanitized native capability descriptors and selection state.
   */
  @Remote({ exportName: 'catalog', requiredCapability: 'harniverse.observe' })
  async catalog(target: CapabilityTarget): Promise<CapabilityCatalogSnapshot> {
    return await this.ctx.capabilities.snapshot(target, this.view(target))
  }

  /**
   * Build a dependency-checked composition dry-run.
   * @param target - composition target edited by this transaction.
   * @param changes - staged explicit load, unload, or inherit values.
   * @param expectedRevision - Settings revision observed by the client.
   * @returns immutable operations, blockers, and resulting catalog.
   */
  @Remote({ exportName: 'plan', requiredCapability: 'harniverse.administer' })
  async plan(
    target: CapabilityTarget,
    changes: readonly CapabilityCompositionChange[],
    expectedRevision: number,
  ): Promise<CapabilityPlan> {
    return await this.ctx.capabilities.plan(target, changes, expectedRevision, this.view(target))
  }

  /**
   * Commit one unchanged dry-run.
   * @param planId - retained dry-run identity.
   * @param expectedRevision - Settings revision the dry-run observed.
   * @returns committed explicit composition values and new revision.
   */
  @Remote({ exportName: 'apply', requiredCapability: 'harniverse.administer' })
  async apply(planId: string, expectedRevision: number): Promise<CapabilityCompositionSnapshot> {
    return await this.ctx.capabilities.apply(planId, expectedRevision)
  }

  /**
   * Read the immutable assembly result of one live Session generation.
   * @param sessionId - live Session to inspect.
   * @returns its Profile, generation, and per-recipe runtime results.
   */
  @Remote({ exportName: 'session', requiredCapability: 'harniverse.observe' })
  session(sessionId: string): SessionCapabilitySnapshot {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`capability-management: session ${JSON.stringify(sessionId)} is not live`)
    const runtime = this.ctx.agentPresets.compositionRuntime(agent.ctx)
    const agentProfile = runtime?.agentProfile ?? agent.session.header.agentProfile
    return {
      sessionId,
      ...agentProfile === undefined ? {} : { agentProfile },
      ...runtime?.generation === undefined ? {} : { generation: runtime.generation },
      entries: runtime?.capabilities ?? [],
    }
  }

  private registerAdapters(ctx: Context): void {
    ctx.capabilities.registerAdapter(() => {
      return {
        id: 'agent-profile-recipes',
        snapshot: async view => ({
          entries: await ctx.agentPresets.capabilityRecipes(view.agentProfile),
          complete: true,
        }),
      }
    })
    ctx.capabilities.registerAdapter((control) => {
      ctx.on('subagent/provider-added', () => { control.invalidate() })
      ctx.on('subagent/provider-removed', () => { control.invalidate() })
      return {
        id: 'harness-subagents',
        snapshot: () => ({ entries: subagentDescriptors(ctx), complete: true }),
      }
    })
  }

  private view(target: CapabilityTarget): CapabilityView {
    return {
      cwd: process.cwd(),
      ...target.kind === 'agent-profile' ? { agentProfile: target.agentProfile } : {},
    }
  }
}

function subagentDescriptors(ctx: Context) {
  return ctx.subagents.list().map(name => ({
    id: `subagent-provider:${name}`,
    kind: 'subagent-provider' as const,
    name,
    description: `Subagent provider ${name}`,
    provenance: name === 'spawn' || name === 'fork' ? 'upstream' as const : 'external' as const,
    assembleable: false,
    available: true,
    defaultLoaded: true,
    manageable: false,
    owner: 'ctx.subagents',
    requires: [],
  }))
}

export default CapabilityManagementGateway
