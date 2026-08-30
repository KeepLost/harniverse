import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveSessionProfile, SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-presets'
import { applyChildComposition, childSessionMeta } from '@deepseek-ai/dsh-subagent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { LosslessCompactionEngine } from '@deepseek-ai/dsh-compaction-lossless'
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type { UserMcpServerConfig } from '@deepseek-ai/dsh-mcp-user-config'
// Type-only: resolves `ctx.get('sessionProjections')` and `ctx.get('tokenMeter')`.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The shipped Web surface: the dsh-base and dsh-web-app bundle patches over an empty preset root. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
/** The installation anchor whose dependency surface the preset module fallback mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const EXAMPLES_INSTALL_ANCHOR = join(REPO_ROOT, 'examples/package.json')
const MINIMAL_PROMPT = 'You are a helpful software engineer assistant.'
const MINIMAL_SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
const MINIMAL_TOOL_NAMES = [MINIMAL_SHELL, 'str_replace_editor']
const MCP_FIXTURE_SERVER = join(REPO_ROOT, 'packages/mcp/mcp-client/tests/fixture-server.ts')
const MCP_FIXTURE_CWD = join(REPO_ROOT, 'packages/mcp/mcp-client')

function mcpFixtureServer(id: string, enabled = true): UserMcpServerConfig {
  return {
    id,
    enabled,
    transport: 'stdio',
    serverName: id,
    command: process.execPath,
    args: [MCP_FIXTURE_SERVER],
    env: {},
    cwd: MCP_FIXTURE_CWD,
    headers: {},
    toolCallTimeoutMs: 15_000,
    failOnStartupError: true,
    reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 1 },
  }
}

/**
 * Boot the shipped Web composition, minus the rows that would bind a port,
 * touch the network, or write outside the test. Everything that decides an
 * agent's capabilities is the real thing, including both shipped presets.
 */
async function bootWeb(
  settingsFile: string,
  extra: PatchOptions[] = [],
  extraInstallAnchor?: string,
): Promise<Context> {
  const home = dirname(settingsFile)
  const storageRoot = join(dirname(settingsFile), 'storages')
  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...loadOverlayPatches('dsh-test', WEB_PATCH),
    // The settings row defaults to `$DSH_HOME/settings.yaml`. Left alone it
    // reads the developer's own document — and since the default preset is a
    // setting, a stored `agent-presets.default` would decide this file's
    // outcome. Point it at a temp file for the same reason the roster below
    // names only the shipped root.
    { id: 'settings', config: { path: settingsFile, watch: false } },
    // storage-json's root is anchored to the real $DSH_HOME. Unpinned, this
    // file writes the developer's own `~/.dsh/storages/` — and then reads it
    // back on the next run, so a stored document from any other build decides
    // this test's boot. Same reason the settings row above is pinned.
    { id: 'storage-json', config: { root: storageRoot } },
    { id: 'authentication', config: { dshHome: home } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    // Host rows with side effects outside this process: a bound port, a served
    // asset tree, a telemetry exporter. `api-gateway` and `directory-picker`
    // stay ENABLED on purpose — the api-proxy is the host row that injects
    // `subagents`, `workspace`, and the rest of the agent plane, so disabling
    // it would hide exactly the breakage this file exists to catch: a service
    // moved into the presets that a host row still waits for. The boot audit
    // is that assertion.
    { id: 'webserver', disabled: true },
    // The web bundle's runtime row injects `webServer`, so it cannot
    // activate without the bound port disabled above. It owns dist serving
    // and the URL context — surface glue, not anything that decides an
    // agent's capabilities, which is all this file asserts.
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    // A deployment-level skill on the host registry's GLOBAL layer — the same
    // registration shape a repository plugin's skill root uses. The layered
    // skills test below proves it reaches preset-composed agents.
    { id: 'skill-badge', disabled: false },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    // The always-on reload chain waits for the browser roster and bound port
    // disabled above.
    { id: 'client-hmr', disabled: true },
    // The shipped `-auto` chooser resolves its interaction from a running
    // host and so waits for the webserver disabled above; the browse variant
    // supplies `directoryPicker` without one.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    // The roster AppCLIEntry would patch in; only the shipped root, so a
    // developer's own `~/.dsh/.preset` cannot change this test's outcome.
    // `default` here is the COMPOSITION default — the base layer the settings
    // document overrides.
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }],
        includeUserRoot: false,
      },
    },
    ...extra,
  ]
  // The surface is patch layers over an empty preset root, so the root sits
  // outside this workspace and bare plugin names cannot resolve by Node's
  // upward walk. The flat fallback the preset boot maintains is what makes
  // them resolvable — the same mechanism, not a test-only shim.
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  if (extraInstallAnchor !== undefined) healProfilesModuleFallback(extraInstallAnchor, home)
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return await boot('dsh-test', rootConfig, patches, (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

function enablePresetTool(composition: string, id: string): string {
  const row = `    - id: ${id}\n`
  const start = composition.indexOf(row)
  if (start < 0) throw new Error(`missing preset row ${id}`)
  const end = composition.indexOf('\n    - id:', start + row.length)
  const disabled = composition.indexOf('      disabled: true\n', start)
  if (disabled < 0 || (end >= 0 && disabled > end)) {
    throw new Error(`preset row ${id} is not disabled`)
  }
  return composition.slice(0, disabled)
    + '      disabled: false\n'
    + composition.slice(disabled + '      disabled: true\n'.length)
}

let ctx: Context
beforeAll(async () => {
  const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-web-presets-')), 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  ctx = await bootWeb(settingsFile)
}, 120_000)

describe('the shipped Web composition', () => {
  it('leaves the global tool layer empty', () => {
    // Every model-facing tool belongs to a preset, `ask_user_question`
    // included: a tool in the global layer reaches EVERY agent regardless of
    // which preset composed it, so a two-tool benchmark surface would really
    // present three. A regression here means an agent-plane row came back to
    // the host composition.
    expect(toolNames(ctx)).toEqual([])
  })

  it('creates an Agent instance with its Profile identity and default permission', async () => {
    const sessionId = SessionId('profile-default-permission')
    const response = await ctx.apiProxy.sessions.create({
      rpcId: RpcId('profile-default-permission'),
      payload: { sessionId, agentProfile: 'standard' },
    })
    expect(response.result).toMatchObject({
      ok: true,
      value: { sessionId, agentProfile: 'standard' },
    })
    const session = ctx.sessions.get(sessionId)
    expect(session?.header.agentProfile).toBe('standard')
    expect(session?.events.filter(event => event.type === 'permission/preset').map(event => event.data.preset))
      .toEqual(['workspace-write'])
    await ctx.agents.close(sessionId)
  })

  it('keeps the token meter and its context-meter projections on the host plane', async () => {
    // Read before any preset in this file mounts, which is what makes this an
    // ownership assertion rather than a mount-order coincidence: a preset-side
    // meter sits behind an `isolate` realm and is invisible to `ctx.get`.
    //
    // The projection registry is process-wide rather than scope-layered, so a
    // preset-side meter would also make the browser's context meter appear for
    // a `minimal` session the moment some OTHER session mounted a preset that
    // carries one, and vanish entirely in a process that only ever ran
    // `minimal`. Host ownership is what makes the meter a per-session fact.
    expect(ctx.get('tokenMeter')).toBeDefined()
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) throw new Error('the Web composition must compose a projection registry')
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal-meter'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // A subset assertion: `tasks`, `goal`, and the rest register into the
      // same process-wide table, and this is about the meter's three units.
      expect(Object.keys(projections.snapshot(handle.agent.session).values))
        .toEqual(expect.arrayContaining(['contextBreakdown', 'contextPressure', 'tokenUsage']))
    } finally {
      await handle.dispose()
    }
  })

  it('supplies both shipped presets, and only those, from the system root', async () => {
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id).sort()).toEqual(['code', 'cordis', 'minimal', 'standard'])
    expect(listed.every(preset => preset.trust === 'system')).toBe(true)
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('composes the full agent from `standard` without tool-result pruning', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-standard'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The EXACT catalog, not a spot-check: an omission is this design's
      // quietest failure mode, because a row that registers into the wrong
      // layer mounts cleanly and simply contributes nothing. `glob`/`grep` are
      // excluded for the reason the TUI composition e2e excludes them — they
      // depend on ripgrep being present on the machine.
      expect(toolNames(ctx, handle.agent).filter(name => name !== 'glob' && name !== 'grep')).toEqual([
        'artifact_read', 'ask_user_question', 'bash', 'child_profile_define', 'child_profile_list',
        'compaction_history_expand', 'compaction_history_search', 'context_compact', 'create_goal',
        'edit', 'exit_plan_mode', 'get_goal', 'job_kill', 'job_list', 'job_output', 'ralph', 'read', 'read_image',
        'session_create', 'session_event_search', 'session_find', 'session_inspect', 'session_message', 'session_search',
        'session_unload', 'skill', 'subagent', 'todo_write', 'update_goal', 'web_fetch', 'web_search',
        'workflow', 'write',
      ])
      const compaction = ctx.agentPresets.serviceFor(handle.agent, 'compaction')
      expect(compaction).toBeDefined()
      expect((compaction as LosslessCompactionEngine).config.auto).toBe(true)
      expect(ctx.agentPresets.serviceFor(handle.agent, 'compactionHistory')).toBeDefined()
      expect(ctx.agentPresets.serviceFor(handle.agent, 'toolResultPruner')).toBeUndefined()
    } finally {
      await handle.dispose()
    }
  })

  it('composes the shared prompt path, two coding tools, and internal recovery from `minimal`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.sections).toEqual([
        { name: 'harness:identity', text: 'You are an AI agent powered by Harniverse.' },
        { name: 'context:file-reference', text: '' },
        { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.' },
        { name: 'ui:deliverable-file-references', text: 'When you successfully create or modify files, mention the primary outputs in your final response. To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn.' },
      ])
      expect(assembly.contexts).toEqual([
        { name: 'deployment:persona', text: MINIMAL_PROMPT },
        { name: 'sandbox:policy', text: '' },
        { name: 'approval:policy', text: '' },
      ])
      expect(assembly.tools.map(tool => tool.name)).toEqual(MINIMAL_TOOL_NAMES)
      expect(JSON.stringify(assembly.tools.find(tool => tool.name === 'str_replace_editor')?.parameters))
        .toContain('Absolute path')
      expect((ctx.agentPresets.serviceFor(handle.agent, 'compaction') as LosslessCompactionEngine).config.auto).toBe(true)
      expect(ctx.agentPresets.serviceFor(handle.agent, 'compactionHistory')).toBeDefined()
    } finally {
      await handle.dispose()
    }
  })

  it('loads enabled user MCP entries into Standard-family profiles without leaking them to Minimal', async () => {
    await ctx.settings.replace(settingsNamespace('mcp'), {
      servers: [mcpFixtureServer('user-tools'), mcpFixtureServer('disabled-tools', false)],
    })
    const standard = await ctx.agents.create({
      sessionId: SessionId(`preset-mcp-standard-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const coded = await ctx.agents.create({
      sessionId: SessionId(`preset-mcp-code-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'code').then(() => undefined),
    })
    const cordis = await ctx.agents.create({
      sessionId: SessionId(`preset-mcp-cordis-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId(`preset-mcp-minimal-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      const mcpTool = 'mcp__user-tools__add'
      const disabledTool = 'mcp__disabled-tools__add'
      await vi.waitFor(() => {
        expect(toolNames(ctx, standard.agent)).toContain(mcpTool)
        expect(toolNames(ctx, cordis.agent)).toContain(mcpTool)
        expect(toolNames(ctx, coded.agent)).toContain(mcpTool)
      }, { timeout: 15_000 })

      expect(toolNames(ctx, standard.agent)).not.toContain(disabledTool)
      expect(toolNames(ctx, cordis.agent)).not.toContain(disabledTool)
      expect(toolNames(ctx, coded.agent)).not.toContain(disabledTool)
      expect(toolNames(ctx, minimal.agent)).toEqual(MINIMAL_TOOL_NAMES)

      const standardAssembly = await ctx.systemPrompt.assemble({ scope: standard.agent })
      expect(standardAssembly.tools.map(tool => tool.name)).toContain(mcpTool)
      const codeAssembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(codeAssembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(codeAssembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain(mcpTool)
    } finally {
      await minimal.dispose()
      await cordis.dispose()
      await coded.dispose()
      await standard.dispose()
      await ctx.settings.replace(settingsNamespace('mcp'), { servers: [] })
    }
  }, 120_000)

  it('keeps project Hook bridges disabled by default in Standard and Minimal', async () => {
    const project = await mkdtemp(join(tmpdir(), 'dsh-preset-hooks-project-'))
    const hookPath = join(project, '.dsh', 'hooks', 'claude-code.json')
    await mkdir(dirname(hookPath), { recursive: true })
    await writeFile(hookPath, JSON.stringify({ hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{
        type: 'command',
        command: `printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'standard project hook' } }).replaceAll("'", "'\\\"'\\\"'")}'`,
      }] }],
    } }))

    const standard = await ctx.agents.create({
      sessionId: SessionId(`preset-hooks-standard-${randomUUID()}`),
      meta: { cwd: project },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId(`preset-hooks-minimal-${randomUUID()}`),
      meta: { cwd: project },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      expect(JSON.stringify(standard.agent.inbox.nextStep)).not.toContain('standard project hook')
      expect(JSON.stringify(minimal.agent.inbox.nextStep)).not.toContain('standard project hook')
      expect(toolNames(ctx, minimal.agent)).toEqual(MINIMAL_TOOL_NAMES)
    } finally {
      await minimal.dispose()
      await standard.dispose()
    }
  }, 120_000)

  it('keeps two differently composed sessions independent', async () => {
    const full = await ctx.agents.create({
      sessionId: SessionId('preset-both-full'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId('preset-both-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      expect(toolNames(ctx, minimal.agent)).toEqual(MINIMAL_TOOL_NAMES)
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)

      await minimal.dispose()

      // Tearing the minimal session down leaves the full one whole.
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)
      expect(toolNames(ctx)).toEqual([])
    } finally {
      await full.dispose()
    }
  })

  it('composes the cordis agent with its own toolset and no tool-result pruning', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
    })
    try {
      const tools = toolNames(ctx, handle.agent)
      // The self-referential toolset is what distinguishes this preset.
      expect(tools).toEqual(expect.arrayContaining([
        'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
        'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
      ]))
      // And it keeps the standard agent's own tools rather than replacing them.
      expect(tools).toEqual(expect.arrayContaining(['bash', 'read', 'edit', 'skill']))
      expect(tools).not.toContain('str_replace_editor')
      expect(ctx.agentPresets.serviceFor(handle.agent, 'toolResultPruner')).toBeUndefined()

      // The preset's own authoring skill registers into ITS layer of the host
      // registry: the cordis agent's view carries it, the global view does not.
      const scoped = (await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('editing-cordis-compositions')
      expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('editing-cordis-compositions')
    } finally {
      await handle.dispose()
    }
  })

  it('presents `code` as Code Mode without tool-result pruning or disturbing a native session', async () => {
    const coded = await ctx.agents.create({
      sessionId: SessionId('preset-code'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'code').then(() => undefined),
    })
    const native = await ctx.agents.create({
      sessionId: SessionId('preset-code-native'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // One tool reaches the MODEL: the transport. The registry's catalog for
      // this agent is unchanged — a code mode collapses the presentation, not
      // the capabilities — so the assembly is what carries the claim.
      const assembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(toolNames(ctx, coded.agent)).not.toContain('str_replace_editor')
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(sdk).not.toContain('str_replace_editor')
      expect(sdk).toContain('web_search')
      expect(sdk).toContain('web_fetch')
      expect(ctx.agentPresets.serviceFor(coded.agent, 'toolResultPruner')).toBeUndefined()

      // The presentation is this agent's alone: the deployment default is
      // native, and the session composed from `standard` still sees it.
      const nativeAssembly = await ctx.systemPrompt.assemble({ scope: native.agent })
      expect(nativeAssembly.tools.map(tool => tool.name)).toContain('bash')
      expect(nativeAssembly.tools.map(tool => tool.name)).not.toContain('run_code')
      expect(nativeAssembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
      expect(ctx.agentPresets.serviceFor(native.agent, 'toolResultPruner')).toBeUndefined()
    } finally {
      await native.dispose()
      await coded.dispose()
    }
  })

  it('keeps the self-referential toolset out of every other preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-no-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // Editing the live runtime is opt-in per session, not ambient.
      expect(toolNames(ctx, handle.agent)).not.toContain('cordis_define')
    } finally {
      await handle.dispose()
    }
  })

  it('ships the composition-authoring skill inside the preset directory', async () => {
    // The preset's skill root is derived from its own `baseUrl`, so the skill
    // travels with the directory wherever the preset is installed.
    const skill = join(
      CONFIG_DIR, 'agent-presets', 'cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md',
    )

    expect((await readFile(skill, 'utf8')).startsWith('---\nname: editing-cordis-compositions')).toBe(true)
  })

  it('merges the global skill layer into a preset agent\'s catalog, keeping local discovery preset-side', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'dsh-preset-skill-proj-'))
    await mkdir(join(proj, '.dsh', 'skills', 'project-proof'), { recursive: true })
    await writeFile(join(proj, '.dsh', 'skills', 'project-proof', 'SKILL.md'), [
      '---',
      'name: project-proof',
      'description: Proves the preset layer discovers project skills beside global ones.',
      '---',
      '',
      'Project proof body.',
      '',
    ].join('\n'))

    const handle = await ctx.agents.create({
      // Unique per run: the composition persists into the ambient DSH home,
      // and a fixed id would collide with a log an earlier run left there.
      sessionId: SessionId(`preset-skills-standard-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The host (global) view carries the deployment-level provider alone:
      // local discovery moved behind the presets with `skill-filesystem`.
      expect((await ctx.skills.list({ cwd: proj })).map(skill => skill.name)).toEqual(['dsh-badge'])

      // The standard agent's view merges the global layer with its preset's
      // own local discovery over the session cwd.
      const scoped = (await ctx.skills.list({ cwd: proj, scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('dsh-badge')
      expect(scoped).toContain('project-proof')

      // The preset's own loader tool resolves the global-layer skill.
      const loaded = await ctx.tools.execute({
        callId: CallId('preset-skills-load'),
        name: 'skill',
        arguments: { name: 'dsh-badge' },
        signal: new AbortController().signal,
        agent: handle.agent,
      })
      expect(loaded.isError).toBe(false)
      expect(JSON.stringify(loaded.content)).toContain('powered by dsh')
    } finally {
      await handle.dispose()
    }
  })

  it('shows a minimal agent the global layer but no loader tool', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`preset-skills-minimal-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // Layer visibility is the registry's; whether an agent can USE skills
      // stays the preset's choice — minimal mounts no `tool-skill`, so its
      // tool table has no loader even though the global layer is readable.
      expect((await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)).toContain('dsh-badge')
      expect(toolNames(ctx, handle.agent)).toEqual(MINIMAL_TOOL_NAMES)
    } finally {
      await handle.dispose()
    }
  })

  it('never rewrites the preset file it composed from', async () => {
    // The Loader persists a tree whose plugin self-disposed, and tearing an
    // agent down disposes its whole subtree. Inherited, that rewrote the
    // shipped composition — truncating it to `[]` the first time a session
    // ended — so `PresetTree` refuses to write at all.
    const path = join(CONFIG_DIR, 'agent-presets', 'standard', 'agent.cordis.yml')
    const before = await readFile(path, 'utf8')

    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-readonly'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await handle.dispose()
    // Slack, not a race the number has to win. The write is driven by the
    // Loader's fiber-unload listener, which fires as the subtree's fibers
    // settle rather than when `dispose()` resolves, and the Loader exposes no
    // flush to await. A regression writes synchronously inside that listener,
    // so any wait past settlement fails; a longer one only slows the test.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('opt-in rows in user presets', () => {
  let productCtx: Context
  const ids = ['products-none', 'products-codex', 'products-claude', 'products-both'] as const

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-product-presets-'))
    const userRoot = join(root, 'presets')
    const settingsFile = join(root, 'settings.yaml')
    const standard = await readFile(join(CONFIG_DIR, 'agent-presets', 'standard', 'agent.cordis.yml'), 'utf8')
    await writeFile(settingsFile, '{}\n')
    for (const id of ids) {
      let composition = standard
      if (id === 'products-codex' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-codex')
      }
      if (id === 'products-claude' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-claude-code')
      }
      const directory = join(userRoot, id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'agent.cordis.yml'), composition)
    }
    const pruningDirectory = join(userRoot, 'pruning-enabled')
    await mkdir(pruningDirectory, { recursive: true })
    await writeFile(
      join(pruningDirectory, 'agent.cordis.yml'),
      enablePresetTool(standard, 'tool-result-pruner'),
    )
    productCtx = await bootWeb(settingsFile, [
      { insert: [
        { id: 'subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' },
        { id: 'subagent-claude-code', name: '@deepseek-ai/dsh-subagent-claude-code' },
      ] },
      {
        id: 'agent-presets',
        config: {
          default: 'standard',
          roots: [
            { path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' },
            { path: userRoot, trust: 'user' },
          ],
          includeUserRoot: false,
        },
      },
    ], EXAMPLES_INSTALL_ANCHOR)
  }, 120_000)

  afterAll(async () => {
    await productCtx.fiber.dispose()
  })

  it('composes none, either product, or both without changing the shared host registry', async () => {
    const expected = new Map<string, string[]>([
      ['products-none', []],
      ['products-codex', ['subagent_codex']],
      ['products-claude', ['subagent_claude_code']],
      ['products-both', ['subagent_claude_code', 'subagent_codex']],
    ])
    expect(productCtx.subagents.list()).toEqual(expect.arrayContaining([
      'spawn', 'fork', 'codex', 'claude-code',
    ]))

    for (const [id, productTools] of expected) {
      const handle = await productCtx.agents.create({
        sessionId: SessionId(`preset-${id}`),
        setup: agentCtx => productCtx.agentPresets.mount(agentCtx, id).then(() => undefined),
      })
      try {
        const tools = toolNames(productCtx, handle.agent)
        expect(tools.filter(name => name === 'subagent_codex' || name === 'subagent_claude_code'))
          .toEqual(productTools)
      } finally {
        await handle.dispose()
      }
    }
  })

  it('activates tool-result pruning when a user preset explicitly enables the row', async () => {
    const handle = await productCtx.agents.create({
      sessionId: SessionId('preset-pruning-enabled'),
      setup: agentCtx => productCtx.agentPresets.mount(agentCtx, 'pruning-enabled').then(() => undefined),
    })
    try {
      expect(productCtx.agentPresets.serviceFor(handle.agent, 'toolResultPruner')).toBeDefined()
    } finally {
      await handle.dispose()
    }
  })

  it('applies a product-row edit only to later sessions on the preset', async () => {
    const preset = await productCtx.agentPresets.resolve('products-none')
    const original = await readFile(preset.path, 'utf8')
    const existing = await productCtx.agents.create({
      sessionId: SessionId('preset-product-generation-existing'),
      setup: agentCtx => productCtx.agentPresets.mount(agentCtx, 'products-none').then(() => undefined),
    })
    try {
      expect(toolNames(productCtx, existing.agent)).not.toContain('subagent_codex')
      await writeFile(preset.path, enablePresetTool(original, 'tool-subagent-codex'))

      const later = await productCtx.agents.create({
        sessionId: SessionId('preset-product-generation-later'),
        setup: agentCtx => productCtx.agentPresets.mount(agentCtx, 'products-none').then(() => undefined),
      })
      try {
        expect(toolNames(productCtx, existing.agent)).not.toContain('subagent_codex')
        expect(toolNames(productCtx, later.agent)).toContain('subagent_codex')
      } finally {
        await later.dispose()
      }
    } finally {
      await existing.dispose()
      await writeFile(preset.path, original)
    }
  })
})

describe('a forked session', () => {
  it('inherits the composition its seeded history was produced under', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-fork-parent'),
      meta: { agentProfile: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    const inherited = resolveSessionProfile(parent.agent.session)
    const child = await ctx.agents.create({
      sessionId: SessionId('preset-fork-child'),
      meta: {
        parentSession: SessionId('preset-fork-parent'),
        seedLength: 0,
        ...inherited === undefined ? {} : { agentProfile: inherited },
      },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, inherited).then(() => undefined),
    })
    try {
      // Composing nothing would leave the child empty: this layer moved every
      // model-facing row out of the host plane, so there is nothing to inherit
      // for free any more.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(toolNames(ctx, child.agent).length).toBeGreaterThan(0)
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('a delegated child', () => {
  it('runs on the composition its parent runs on', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-child-parent'),
      meta: { agentProfile: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    // Exactly what an in-process subagent driver's creation window does.
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('preset-child'),
      meta: childSessionMeta(parent.agent, 1, 0),
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent.agent, {})
      },
    })
    try {
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      // The shipped `standard` preset is the whole coding agent; an empty
      // child here is the defect, and equality alone would not catch it.
      expect(toolNames(ctx, child.agent)).toContain('bash')
      expect(child.agent.session.header.agentProfile).toBe('standard')
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })

})

describe('a launcher that configures no writable root', () => {
  // The claim this default exists for, asserted through the real shipped
  // bundles rather than a hand-built context: `apps/cli` patches in only the
  // system root, and a person's own presets are found anyway because the
  // roster derives `<dshHome>/.agent-presets` itself. `$DSH_HOME` is pointed
  // at a temp home BEFORE boot — the derived root is resolved when the plugin
  // is constructed, and an unpinned run would read the developer's own.
  let derivedCtx: Context
  let previousHome: string | undefined

  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-preset-derived-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await mkdir(join(home, '.agent-presets', 'derived-mine'), { recursive: true })
    await writeFile(
      join(home, '.agent-presets', 'derived-mine', 'agent.cordis.yml'),
      '- id: tool-todo\n  name: \'@deepseek-ai/dsh-tool-todo\'\n  config:\n    allowParallelInProgress: true\n',
    )
    const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-preset-derived-settings-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    // Only the shipped root, exactly what `composeProfile` supplies; the
    // writable one is the roster's own default rather than this patch's job.
    derivedCtx = await bootWeb(settingsFile, [{
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }],
        includeUserRoot: true,
      },
    }])
  }, 120_000)

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await derivedCtx.fiber.dispose()
  })

  it('discovers and mounts a preset the person authored under the harness home', async () => {
    const listed = await derivedCtx.agentPresets.list()

    const mine = listed.find(preset => preset.id === 'derived-mine')
    expect(mine).toMatchObject({ trust: 'user' })
    // Omitted rather than undefined: a healthy row carries no `broken` key.
    expect(mine?.broken).toBeUndefined()
    expect(derivedCtx.agentPresets.authorable).toBe(true)

    const handle = await derivedCtx.agents.create({
      sessionId: SessionId('preset-derived-root'),
      setup: agentCtx => derivedCtx.agentPresets.mount(agentCtx, 'derived-mine').then(() => undefined),
    })
    try {
      expect(toolNames(derivedCtx, handle.agent)).toContain('todo_write')
    } finally {
      await handle.dispose()
    }
  })
})

describe('authoring a preset on the shipped composition', () => {
  let authorCtx: Context
  let userRoot: string

  beforeAll(async () => {
    userRoot = join(await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-')), 'profiles')
    const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-settings-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    authorCtx = await bootWeb(settingsFile, [{
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [
          { path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' },
          // The root does not exist yet: a deployment whose user has authored
          // nothing is the normal first-run state.
          { path: userRoot, trust: 'user' },
        ],
        includeUserRoot: false,
      },
    }])
  })

  it('refuses to copy over or delete a shipped preset', async () => {
    await expect(authorCtx.agentPresets.copy('minimal', 'standard')).rejects.toThrow(/already exists/)
    await expect(authorCtx.agentPresets.remove('standard')).rejects.toThrow(/ships with the deployment/)
  })

  it.each(['../escape', 'a/b', '/abs', 'Upper'])('refuses the uncontainable id %j', async (id) => {
    // The id becomes a directory name under the user root, so containment is
    // checked on the id rather than on the joined path afterwards.
    await expect(authorCtx.agentPresets.copy('minimal', id)).rejects.toThrow()
  })

  it('copies a shipped preset a session then really composes from', async () => {
    await authorCtx.agentPresets.copy('minimal', 'my-agent', '我的模式')

    // Round-trips through the roster as a `user` row carrying the given name
    // and the source's description, over the source's own composition text.
    const preset = await authorCtx.agentPresets.resolve('my-agent')
    const source = await authorCtx.agentPresets.resolve('minimal')
    expect(preset.trust).toBe('user')
    expect(preset.name).toBe('我的模式')
    expect(preset.description).toBe(source.description)
    expect(await authorCtx.agentPresets.read('my-agent')).toBe(await authorCtx.agentPresets.read('minimal'))
    // Owner-only, in an owner-only directory: a composition is executable
    // configuration on a machine that may have other users.
    expect((await stat(preset.path)).mode & 0o777).toBe(0o600)
    const handle = await authorCtx.agents.create({
      sessionId: SessionId('preset-authored'),
      setup: agentCtx => authorCtx.agentPresets.mount(agentCtx, 'my-agent').then(() => undefined),
    })
    try {
      // The same tools the shipped `minimal` composes, from a directory copied
      // through the service into a root outside the installed harness.
      expect(toolNames(authorCtx, handle.agent)).toEqual(MINIMAL_TOOL_NAMES)
    } finally {
      await handle.dispose()
    }
  })

  it('deletes what it copied', async () => {
    await authorCtx.agentPresets.copy('minimal', 'doomed')

    await authorCtx.agentPresets.remove('doomed')

    expect((await authorCtx.agentPresets.list()).map(preset => preset.id)).not.toContain('doomed')
  })
})

/**
 * Which preset an unnamed session gets is a user setting layered over the
 * composition's own default. The package suite proves the layering against a
 * hand-built context; this proves it through the shipped `cordis.yml` — that
 * the roster and the settings provider are actually wired to each other, and
 * that the id the setting names is the one a session composes from.
 */
describe('the default preset as a user setting', () => {
  it('composes an unnamed session from the stored default, not the composed one', async () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')

    await ctx.settings.update(settingsNamespace(SETTINGS_NAMESPACE), { default: 'minimal' })
    try {
      expect(ctx.agentPresets.defaultId).toBe('minimal')

      const handle = await ctx.agents.create({
        sessionId: SessionId('preset-user-default'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      try {
        // `mount()` with no id resolves the effective default. The minimal
        // catalog, not `standard`'s, proves the setting decided composition.
        expect(toolNames(ctx, handle.agent)).toEqual(MINIMAL_TOOL_NAMES)
      } finally {
        await handle.dispose()
      }
    } finally {
      // The context is shared with the rest of the file. `replace({})` drops
      // the user section wholesale so the field re-inherits the composition
      // base; `update` merges, and would leave the override standing.
      await ctx.settings.replace(settingsNamespace(SETTINGS_NAMESPACE), {})
    }

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('a session keeps the preset it was created with', () => {
  it('refuses to adopt a live session under a different preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-locked'),
      meta: { agentProfile: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // The api-proxy guard reads exactly this: the header records what the
      // session runs, so naming anything else is a caller error rather than a
      // switch. Its history was produced under `minimal`'s two tools.
      expect(handle.agent.session.header.agentProfile).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })
})
