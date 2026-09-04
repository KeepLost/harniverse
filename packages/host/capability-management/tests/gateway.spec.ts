import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Capabilities, { type CapabilityCatalogSnapshot, type CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import CapabilityManagementGateway from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const contexts: Context[] = []
const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A minimal registrable Tool whose only purpose is to be denied or allowed. */
function tool(name: string) {
  return {
    name,
    description: `${name} files`,
    parameters: { type: 'object' } as const,
    output: {
      schema: { type: 'string' } as const,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }],
    },
    execute: async () => name,
  }
}

/** One on-disk skill root holding a single directory-form skill. */
async function skillRoot(name: string, description: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-skills-'))
  tempRoots.push(root)
  await mkdir(join(root, name), { recursive: true })
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the ${name} skill.\n`,
  )
  return root
}

function recipe(name: string, defaultLoaded: boolean): CapabilityDescriptor {
  return {
    id: `plugin:${name}`,
    kind: 'tool',
    name,
    description: `Profile plugin ${name}`,
    provenance: 'upstream',
    assembleable: true,
    available: true,
    defaultLoaded,
    manageable: true,
    owner: `@deepseek-ai/dsh-${name}`,
    requires: [],
  }
}

/** Options that vary the deployment shape one gateway observes. */
interface HarnessOptions {
  /** Omit the optional sessionPersistence service entirely. */
  withoutPersistence?: boolean
  /** Extra descriptors appended to every capability catalog. */
  extraDescriptors?: CapabilityDescriptor[]
  /** Static recipes keyed by capability id. */
  recipes?: Map<string, unknown>
  /** Replace the live-Agent composition runtime result. */
  compositionRuntime?: () => unknown
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Capabilities)
  let standingReads = 0
  let runtimeAgent: { ctx: Context; session: { header: { agentProfile?: string } } } | undefined
  const runtimeCapabilities = [{
    ...recipe('profile-tool', true),
    selection: 'inherit' as const,
    effectiveSelection: 'load' as const,
    selected: true,
    status: 'loaded' as const,
  }]
  ctx.provide('agentPresets', {
    list: () => Promise.resolve([{ id: 'standard' }, { id: 'minimal' }]),
    standingKeyFor: () => { standingReads += 1; return Promise.resolve({}) },
    capabilityCatalog: (id?: string) => Promise.resolve({
      descriptors: [{
        ...recipe('profile-tool', id === undefined || id === 'standard'),
        members: ['read', 'write'].map(name => ({
          id: `plugin:profile-tool/tool:${name}`,
          kind: 'tool' as const,
          name,
          description: `${name} files`,
          defaultVisible: true,
          available: true,
          requires: [],
        })),
      }, {
        ...recipe('minimal-tool', id === undefined || id === 'minimal'),
        members: [{
          id: 'plugin:minimal-tool/tool:read',
          kind: 'tool' as const,
          name: 'read',
          description: 'alternate read provider',
          defaultVisible: true,
          available: true,
          requires: [],
        }],
      }, ...options.extraDescriptors ?? []],
      recipes: options.recipes ?? new Map(),
    }),
    compositionRuntime: options.compositionRuntime
      ?? (() => ({ agentProfile: 'standard', generation: 'standard@2', capabilities: runtimeCapabilities })),
    standingCompositionRuntime: (id?: string) => Promise.resolve({
      agentProfile: id ?? 'standard',
      generation: `${id ?? 'standard'}@2`,
      capabilities: runtimeCapabilities,
    }),
  })
  ctx.provide('agents', { get: () => runtimeAgent })
  if (options.withoutPersistence !== true) {
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([
        { id: 'cold-session', agentProfile: 'minimal' },
        { id: 'cold-unrecorded' },
      ]),
    })
  }
  await ctx.plugin(CapabilityManagementGateway)
  return {
    ctx,
    gateway: ctx.get('capabilityManagement') as CapabilityManagementGateway,
    standingReads: () => standingReads,
    setRuntimeAgent: (agent: typeof runtimeAgent) => { runtimeAgent = agent },
  }
}

describe('CapabilityManagementGateway', () => {
  it('separates observation from authorized composition mutation', async () => {
    const { gateway } = await harness()
    expect(remoteMethods(gateway)).toEqual([
      { method: 'catalog', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'plan', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.administer' },
      { method: 'apply', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.administer' },
      { method: 'session', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
    ])
  })

  it('projects a Profile tool and commits only an unblocked revision-fenced plan', async () => {
    const { gateway } = await harness()
    const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
    const catalog = await gateway.catalog(target)
    expect(catalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin:profile-tool', kind: 'tool', manageable: true, selected: true }),
    ]))

    const plan = await gateway.plan(target, [
      { capabilityId: 'plugin:profile-tool', selection: 'unload' },
    ], catalog.revision)
    expect(plan.blockers).toEqual([])
    const applied = await gateway.apply(plan.id, catalog.revision)
    expect(applied.values).toEqual({ 'plugin:profile-tool': { selection: 'unload' } })
    await expect(gateway.apply(plan.id, catalog.revision)).rejects.toThrow(/expired/)
  })

  it('projects one deployment capability universe with target-specific availability', async () => {
    const { gateway, standingReads } = await harness()
    const global = await gateway.catalog({ kind: 'global-agent' })
    const standard = await gateway.catalog({ kind: 'agent-profile', agentProfile: 'standard' })
    const minimal = await gateway.catalog({ kind: 'agent-profile', agentProfile: 'minimal' })
    const ids = (entries: CapabilityCatalogSnapshot['entries']) => entries.map(entry => entry.id)

    expect(ids(standard.entries)).toEqual(ids(global.entries))
    expect(ids(minimal.entries)).toEqual(ids(global.entries))
    expect(standard.entries.find(entry => entry.id === 'plugin:profile-tool')).toMatchObject({ assembleable: true, selected: true })
    expect(standard.entries.find(entry => entry.id === 'plugin:minimal-tool')).toMatchObject({ assembleable: true, selected: false })
    expect(minimal.entries.find(entry => entry.id === 'plugin:profile-tool')).toMatchObject({ assembleable: true, selected: false })
    expect(minimal.entries.find(entry => entry.id === 'plugin:minimal-tool')).toMatchObject({ assembleable: true, selected: true })
    expect(standingReads()).toBe(0)
  })

  it('enforces a Profile member allowlist through the native Tool registry', async () => {
    const { ctx, gateway } = await harness()
    for (const name of ['read', 'write']) {
      ctx.tools.register({
        name,
        description: `${name} files`,
        parameters: { type: 'object' },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: async () => name,
      })
    }
    const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
    const catalog = await gateway.catalog(target)
    const capability = catalog.entries.find(entry => entry.id === 'plugin:profile-tool')
    if (capability === undefined) throw new Error('profile-tool capability must exist')
    const read = capability.memberEntries?.find(member => member.name === 'read')
    if (read === undefined) throw new Error('profile-tool read member must exist')
    const plan = await gateway.plan(target, [{ capabilityId: capability.id, members: [read.id] }], catalog.revision)
    await gateway.apply(plan.id, catalog.revision)
    const standingKey = { profile: 'standard' }
    const standing = createScope(ctx, standingKey)
    ctx.capabilities.mountComposition(standing.ctx, (await gateway.catalog(target)).entries)

    expect(ctx.tools.schemas(standingKey).map(tool => tool.name)).toContain('read')
    expect(ctx.tools.schemas(standingKey).map(tool => tool.name)).not.toContain('write')
    await standing.dispose()
  })

  it('returns the immutable assembly result for a live Session generation', async () => {
    const { ctx, gateway, setRuntimeAgent } = await harness()
    setRuntimeAgent({ ctx, session: { header: {} } })

    await expect(gateway.session('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      agentProfile: 'standard',
      generation: 'standard@2',
      entries: [expect.objectContaining({ id: 'plugin:profile-tool', status: 'loaded' })],
    })
  })

  it('reads a cold listed Session through the recorded Profile standing generation', async () => {
    const { gateway } = await harness()

    // No live Agent: a Session the operator opens from the list is cold until
    // it runs a turn, and its assembly is still readable.
    await expect(gateway.session('cold-session')).resolves.toMatchObject({
      sessionId: 'cold-session',
      agentProfile: 'minimal',
      generation: 'minimal@2',
      entries: [expect.objectContaining({ id: 'plugin:profile-tool', status: 'loaded' })],
    })
    // A log from before the roster existed resolves the default composition.
    await expect(gateway.session('cold-unrecorded')).resolves.toMatchObject({
      sessionId: 'cold-unrecorded',
      agentProfile: 'standard',
    })
    await expect(gateway.session('never-existed')).rejects.toThrow(/is not known/)
  })

  it('falls back to the recorded header Profile when the runtime reports none', async () => {
    const { ctx, gateway, setRuntimeAgent } = await harness({
      compositionRuntime: () => ({ capabilities: [] }),
    })
    setRuntimeAgent({ ctx, session: { header: { agentProfile: 'from-header' } } })

    await expect(gateway.session('session-2')).resolves.toEqual({
      sessionId: 'session-2',
      agentProfile: 'from-header',
      entries: [],
    })
  })

  it('omits an unknown Profile and generation for a live Session', async () => {
    const { ctx, gateway, setRuntimeAgent } = await harness({
      compositionRuntime: () => undefined,
    })
    setRuntimeAgent({ ctx, session: { header: {} } })

    // No runtime and no recorded Profile: the assembly is still a fact, and
    // absent identity stays absent rather than becoming a guess.
    await expect(gateway.session('session-3')).resolves.toEqual({
      sessionId: 'session-3',
      entries: [],
    })
  })

  it('resolves the roster default when no persistence service is mounted', async () => {
    const { gateway } = await harness({ withoutPersistence: true })

    await expect(gateway.session('any-session')).resolves.toMatchObject({
      sessionId: 'any-session',
      agentProfile: 'standard',
    })
  })

  describe('member restriction', () => {
    it('restricts nothing without a scoped composition context', async () => {
      const { ctx, gateway } = await harness()
      ctx.tools.register(tool('read'))
      const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
      const entries = (await gateway.catalog(target)).entries

      // An unscoped context has no restriction layer to own the denial.
      expect(() => { ctx.capabilities.mountComposition(ctx, entries) }).not.toThrow()
    })

    it('ignores non-plugin entries and entries without members', async () => {
      const { ctx, gateway } = await harness({
        extraDescriptors: [recipe('memberless', true)],
      })
      ctx.subagents.registerProvider({ name: 'acp', capabilities: {}, inheritsParentContext: false } as never)
      ctx.tools.register(tool('read'))
      ctx.tools.register(tool('write'))
      const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
      const entries = (await gateway.catalog(target)).entries
      expect(entries.map(entry => entry.id)).toContain('subagent-provider:acp')
      expect(entries.find(entry => entry.id === 'plugin:memberless')?.memberEntries).toBeUndefined()

      const key = { profile: 'unrestricted' }
      const scope = createScope(ctx, key)
      ctx.capabilities.mountComposition(scope.ctx, entries)

      // Every member is visible by default, so nothing is denied.
      expect(ctx.tools.schemas(key).map(item => item.name)).toEqual(expect.arrayContaining(['read', 'write']))
      await scope.dispose()
    })
  })

  describe('filesystem skill members', () => {
    const SKILL_ID = 'plugin:skill-filesystem'

    /** The skill-filesystem descriptor whose members the adapter replaces. */
    const skillDescriptor = (): CapabilityDescriptor => ({
      ...recipe('skill-filesystem', true),
      kind: 'skill',
      members: [{
        id: `${SKILL_ID}/skill:placeholder`,
        kind: 'skill' as const,
        name: 'placeholder',
        description: 'replaced by discovery',
        defaultVisible: true,
        available: true,
        requires: [],
      }],
    })

    it('replaces declared members with host-discovered skills', async () => {
      const root = await skillRoot('alpha-skill', 'Alpha description')
      const { gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: { config: { includeDefaultRoots: false, customSkillDirs: [root] } },
          canonicalBaseUrl: pathToFileURL(join(root, 'cordis.yml')).href,
        }]]),
      })

      const entry = (await gateway.catalog({ kind: 'global-agent' })).entries
        .find(candidate => candidate.id === SKILL_ID)
      expect(entry?.memberEntries).toEqual([expect.objectContaining({
        id: `${SKILL_ID}/skill:alpha-skill`,
        kind: 'skill',
        name: 'alpha-skill',
        description: 'Alpha description',
      })])
    })

    it('prefers an overlay source over the canonical row', async () => {
      const canonicalRoot = await skillRoot('canonical-skill', 'Canonical')
      const sourceRoot = await skillRoot('source-skill', 'From the overlay source')
      const { gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: { config: { includeDefaultRoots: false, customSkillDirs: [canonicalRoot] } },
          canonicalBaseUrl: pathToFileURL(join(canonicalRoot, 'cordis.yml')).href,
          source: { config: { includeDefaultRoots: false, customSkillDirs: [sourceRoot] } },
          sourceBaseUrl: pathToFileURL(join(sourceRoot, 'cordis.yml')).href,
        }]]),
      })

      const names = (await gateway.catalog({ kind: 'global-agent' })).entries
        .find(candidate => candidate.id === SKILL_ID)?.memberEntries?.map(member => member.name)
      expect(names).toEqual(['source-skill'])
    })

    it('resolves a static baseUrl-relative skill directory expression', async () => {
      const root = await skillRoot('expr-skill', 'Resolved through the static expression')
      const baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
      const { gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: {
            config: {
              providerName: 'local',
              includeDefaultRoots: false,
              dshHome: join(root, 'dsh-home'),
              agentsHome: join(root, 'agents-home'),
              bundledSkillDir: join(root, 'bundled'),
              // The shipped composition expresses a package-relative root as a
              // static `!!js` expression rather than an absolute path.
              customSkillDirs: [{
                __jsExpr: 'process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'.\', baseUrl))',
              }],
            },
          },
          canonicalBaseUrl: baseUrl,
        }]]),
      })

      const names = (await gateway.catalog({ kind: 'global-agent' })).entries
        .find(candidate => candidate.id === SKILL_ID)?.memberEntries?.map(member => member.name)
      expect(names).toEqual(['expr-skill'])
    })

    it.each([
      ['a non-object config', null],
      ['an array config', []],
      ['a config of unusable value types', { providerName: 1, includeDefaultRoots: 'yes', customSkillDirs: 'not-a-list' }],
      ['unresolvable directory entries', { includeDefaultRoots: false, customSkillDirs: [42, {}, { __jsExpr: 7 }, { __jsExpr: 'process.exit(1)' }] }],
      // A static expression may name any URL; only a local directory is usable.
      ['a non-file resolved directory URL', {
        includeDefaultRoots: false,
        customSkillDirs: [{
          __jsExpr: 'process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'https://example.invalid/skills/\', baseUrl))',
        }],
      }],
    ])('discovers no member from %s', async (_label, config) => {
      const { gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: { config },
          canonicalBaseUrl: pathToFileURL(join(tmpdir(), 'cordis.yml')).href,
        }]]),
      })

      const entry = (await gateway.catalog({ kind: 'global-agent' })).entries
        .find(candidate => candidate.id === SKILL_ID)
      expect(entry?.memberEntries?.some(member => member.name === 'placeholder')).toBe(false)
    })

    it('keeps the highest-ranked skill when two roots declare one name', async () => {
      const first = await skillRoot('duplicate-skill', 'First root wins')
      const second = await skillRoot('duplicate-skill', 'Second root loses')
      const { gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: { config: { includeDefaultRoots: false, customSkillDirs: [first, second] } },
          canonicalBaseUrl: pathToFileURL(join(first, 'cordis.yml')).href,
        }]]),
      })

      const members = (await gateway.catalog({ kind: 'global-agent' })).entries
        .find(candidate => candidate.id === SKILL_ID)?.memberEntries
      expect(members?.filter(member => member.name === 'duplicate-skill')).toHaveLength(1)
    })

    it('restricts the Skill registry to a custom member selection', async () => {
      const root = await skillRoot('kept-skill', 'Kept')
      await mkdir(join(root, 'dropped-skill'), { recursive: true })
      await writeFile(
        join(root, 'dropped-skill', 'SKILL.md'),
        '---\nname: dropped-skill\ndescription: Dropped\n---\n\nDropped body.\n',
      )
      const skillConfig = { includeDefaultRoots: false, customSkillDirs: [root] }
      const { ctx, gateway } = await harness({
        extraDescriptors: [skillDescriptor()],
        recipes: new Map([[SKILL_ID, {
          rowId: 'row-skill',
          canonical: { config: skillConfig },
          canonicalBaseUrl: pathToFileURL(join(root, 'cordis.yml')).href,
        }]]),
      })
      // The same discovery the adapter projects also feeds the live registry,
      // so the allowlist is enforced against real host-local skills.
      await ctx.plugin(SkillFileSystem, skillConfig)
      const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
      const catalog = await gateway.catalog(target)
      const entry = catalog.entries.find(candidate => candidate.id === SKILL_ID)
      const kept = entry?.memberEntries?.find(member => member.name === 'kept-skill')
      if (kept === undefined) throw new Error('kept-skill member must exist')

      const plan = await gateway.plan(target, [{ capabilityId: SKILL_ID, members: [kept.id] }], catalog.revision)
      await gateway.apply(plan.id, catalog.revision)
      const key = { profile: 'skill-restricted' }
      const scope = createScope(ctx, key)
      ctx.capabilities.mountComposition(scope.ctx, (await gateway.catalog(target)).entries)

      const visible = (await ctx.skills.list({ scope: key })).map(skill => skill.name)
      expect(visible).toContain('kept-skill')
      expect(visible).not.toContain('dropped-skill')
      await scope.dispose()
    })
  })

  describe('native Harness adapters', () => {
    it('projects every registered subagent provider by provenance', async () => {
      const { ctx, gateway } = await harness()
      ctx.subagents.registerProvider({
        name: 'acp',
        capabilities: {},
        inheritsParentContext: false,
      } as never)

      const entries = (await gateway.catalog({ kind: 'global-agent' })).entries
      const providers = entries.filter(entry => entry.id.startsWith('subagent-provider:'))
      expect(providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'subagent-provider:acp',
          kind: 'subagent-provider',
          name: 'acp',
          description: 'Subagent provider acp',
          // Only the two upstream providers are upstream-provenance.
          provenance: 'external',
          assembleable: false,
          manageable: false,
          owner: 'ctx.subagents',
        }),
      ]))
    })

    it('marks the two upstream providers as upstream provenance', async () => {
      const { ctx, gateway } = await harness()
      for (const name of ['spawn', 'fork']) {
        ctx.subagents.registerProvider({ name, capabilities: {}, inheritsParentContext: false } as never)
      }

      const entries = (await gateway.catalog({ kind: 'global-agent' })).entries
      for (const name of ['spawn', 'fork']) {
        expect(entries.find(entry => entry.id === `subagent-provider:${name}`))
          .toMatchObject({ provenance: 'upstream' })
      }
    })

    it('invalidates the catalog when a provider or skill set changes', async () => {
      const { ctx, gateway } = await harness()
      const before = await gateway.catalog({ kind: 'global-agent' })
      const remove = ctx.subagents.registerProvider({
        name: 'acp',
        capabilities: {},
        inheritsParentContext: false,
      } as never)

      const added = await gateway.catalog({ kind: 'global-agent' })
      expect(added.entries.map(entry => entry.id)).toContain('subagent-provider:acp')
      remove()
      const removed = await gateway.catalog({ kind: 'global-agent' })
      expect(removed.entries.map(entry => entry.id)).not.toContain('subagent-provider:acp')
      expect(removed.entries.map(entry => entry.id)).toEqual(before.entries.map(entry => entry.id))

      // A host-local skill change invalidates the recipe adapter too.
      expect(() => { ctx.emit('skills/change') }).not.toThrow()
      await expect(gateway.catalog({ kind: 'global-agent' })).resolves.toBeDefined()
    })
  })
})
