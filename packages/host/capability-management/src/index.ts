/** Authorized capability management and native Harness adapters. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent'
import type {
  CapabilityCatalogSnapshot,
  CapabilityCatalogEntry,
  CapabilityCompositionChange,
  CapabilityCompositionSnapshot,
  CapabilityPlan,
  SessionCapabilitySnapshot,
  CapabilityTarget,
  CapabilityView,
} from '@deepseek-ai/dsh-capabilities'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: activates the optional sessionPersistence Context merge the cold
// Session read resolves through ctx.get.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-skill'
import { discoverFileSystemSkills, type Config as FileSystemSkillConfig } from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'

export type * from './types.ts'

/** Authorized Remote over static Profile recipes and immutable Session assembly results. */
export class CapabilityManagementGateway extends TypertRemoteService {
  static inject = ['capabilities', 'agentPresets', 'agents', 'subagents', 'skills']

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
  async session(sessionId: string): Promise<SessionCapabilitySnapshot> {
    const id = SessionId(sessionId)
    const agent = this.ctx.agents.get(id)
    if (agent !== undefined) {
      const runtime = this.ctx.agentPresets.compositionRuntime(agent.ctx)
      const agentProfile = runtime?.agentProfile ?? agent.session.header.agentProfile
      return {
        sessionId,
        ...agentProfile === undefined ? {} : { agentProfile },
        ...runtime?.generation === undefined ? {} : { generation: runtime.generation },
        entries: runtime?.capabilities ?? [],
      }
    }
    // A listed Session the operator opens is cold until it runs a turn, and
    // its assembly is still a fact: the standing generation of the Profile the
    // log recorded composes plugins without resuming an agent, session, or
    // turn (the presenter-scope precedent in api-proxy).
    const stored = await this.storedProfile(id)
    const runtime = await this.ctx.agentPresets.standingCompositionRuntime(stored)
    return {
      sessionId,
      agentProfile: runtime.agentProfile,
      generation: runtime.generation,
      entries: runtime.capabilities,
    }
  }

  /** The Profile a cold Session recorded; undefined resolves the roster default. */
  private async storedProfile(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const header = (await persistence.list()).find(candidate => candidate.id === sessionId)
    if (header === undefined) {
      throw new Error(`capability-management: session ${JSON.stringify(sessionId)} is not known`)
    }
    return header.agentProfile
  }

  private registerAdapters(ctx: Context): void {
    ctx.capabilities.registerAdapter((control) => {
      ctx.on('skills/change', () => { control.invalidate() })
      return {
        id: 'agent-profile-recipes',
        snapshot: async view => ({ entries: await recipeDescriptors(ctx, view), complete: true }),
        restrict: (compositionCtx, entries) => { restrictRecipeMembers(compositionCtx, entries) },
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

function restrictRecipeMembers(ctx: Context, entries: readonly CapabilityCatalogEntry[]): void {
  const tools = ctx.get('tools')
  const scope = scopeOf(ctx)
  if (tools === undefined || scope === undefined) return
  const known = new Set(tools.schemas(scope).map(tool => tool.name))
  const visibleByName = new Map<string, boolean>()
  for (const entry of entries) {
    if (!entry.id.startsWith('plugin:')) continue
    for (const member of entry.memberEntries ?? []) {
      visibleByName.set(member.name, (visibleByName.get(member.name) ?? false) || entry.selected && member.visible)
    }
  }
  const denied = [...visibleByName].filter(([name, visible]) => !visible && known.has(name)).map(([name]) => name)
  if (denied.length > 0) tools.restrict({ deny: denied, includeOwn: true })
  const skillEntry = entries.find(entry => entry.id === 'plugin:skill-filesystem')
  const skills = ctx.get('skills')
  // A custom member selection always carries its entries: the catalog projects
  // both from one descriptor's `members`.
  const skillMembers = skillEntry?.memberSelection === 'custom' ? skillEntry.memberEntries : undefined
  if (skills !== undefined && skillEntry?.selected === true && skillMembers !== undefined) {
    skills.restrict({
      allow: skillMembers.filter(member => member.visible).map(member => member.name),
      includeOwn: true,
    })
  }
}

async function recipeDescriptors(ctx: Context, view: CapabilityView) {
  const catalog = await ctx.agentPresets.capabilityCatalog(view.agentProfile)
  const skillRecipe = catalog.recipes.get('plugin:skill-filesystem')
  const skillSource = skillRecipe?.source ?? skillRecipe?.canonical
  const skillBaseUrl = skillRecipe?.source === undefined ? skillRecipe?.canonicalBaseUrl : skillRecipe.sourceBaseUrl
  const discovered = await discoverFileSystemSkills(
    ctx,
    view.cwd,
    fileSystemSkillConfig(skillSource?.config, skillBaseUrl),
  )
  const skills = new Map<string, (typeof discovered)[number]>()
  for (const skill of [...discovered].sort((left, right) => left.rank - right.rank)) {
    if (!skills.has(skill.name)) skills.set(skill.name, skill)
  }
  return catalog.descriptors.map((descriptor) => {
    if (descriptor.id !== 'plugin:skill-filesystem') return descriptor
    return {
      ...descriptor,
      members: [...skills.values()].sort((left, right) => left.name.localeCompare(right.name)).map(skill => ({
        id: `${descriptor.id}/skill:${skill.name}`,
        kind: 'skill' as const,
        name: skill.name,
        description: skill.description,
        defaultVisible: skill.invocation.modelInvocable,
        available: true,
        requires: [],
      })),
    }
  })
}

function fileSystemSkillConfig(value: unknown, baseUrl: string | undefined): FileSystemSkillConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  return {
    ...typeof source.providerName === 'string' ? { providerName: source.providerName } : {},
    ...typeof source.includeDefaultRoots === 'boolean' ? { includeDefaultRoots: source.includeDefaultRoots } : {},
    ...typeof source.dshHome === 'string' ? { dshHome: source.dshHome } : {},
    ...typeof source.agentsHome === 'string' ? { agentsHome: source.agentsHome } : {},
    ...Array.isArray(source.customSkillDirs)
      ? { customSkillDirs: source.customSkillDirs.flatMap(item => staticSkillDirectory(item, baseUrl)) }
      : {},
    ...typeof source.bundledSkillDir === 'string' ? { bundledSkillDir: source.bundledSkillDir } : {},
  }
}

function staticSkillDirectory(value: unknown, baseUrl: string | undefined): string[] {
  if (typeof value === 'string') return [value]
  if (baseUrl === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const expression = (value as Record<string, unknown>).__jsExpr
  if (typeof expression !== 'string') return []
  const match = /^process\.getBuiltinModule\((['"])node:url\1\)\.fileURLToPath\(new URL\((['"])([^'"]+)\2, baseUrl\)\)$/.exec(expression)
  if (match?.[3] === undefined) return []
  const resolved = new URL(match[3], baseUrl)
  return resolved.protocol === 'file:' ? [fileURLToPath(resolved)] : []
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
