import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Supervision from '@deepseek-ai/dsh-supervision'
import { homeHookAdapterPath } from '@deepseek-ai/dsh-hook-protocol'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SubagentRunId, type SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig } from '@deepseek-ai/dsh-hooks-claude-code/src/config.ts'
import * as ToolHooks from '../src/index.ts'
import { ADAPTER_SOURCE, bridgeCommand, installAdapter } from '../src/adapter.ts'
import { addEntry, listEntries, openStore, removeEntry, workspaceHooksDir, writeStore } from '../src/store.ts'
import * as Invariant from '../src/invariant.ts'

const activeContexts: Context[] = []
const activeDirs: string[] = []
const priorHome = process.env.DSH_HOME

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (priorHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
  else process.env.DSH_HOME = priorHome
})

function track(dir: string): string {
  activeDirs.push(dir)
  return dir
}

function workspace(): string {
  return track(mkdtempSync(join(tmpdir(), 'tool-hooks-')))
}

/** A fresh harness home so adapter installs and global-scope writes stay in temp. */
function home(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'tool-hooks-home-')))
  process.env.DSH_HOME = dir
  return dir
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

async function mount(cwd: string | undefined, config: ToolHooks.Config = {}, supervision?: 'supervised' | 'unsupervised'): Promise<{
  ctx: Context
  session: Session
  call: (tool: string, args: unknown, options?: { agent?: Agent }) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  if (supervision !== undefined) await ctx.plugin(Supervision, { mode: supervision })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolHooks, config)
  let calls = 0
  const session = ctx.sessions.create(SessionId('caller'), {
    meta: { createdAt: 1, ...cwd === undefined ? {} : { cwd } },
  })
  const agent = fakeAgent(session)
  return {
    ctx,
    session,
    call: (tool, args, options) => {
      const base = {
        name: tool,
        arguments: args,
        callId: CallId(`call-${++calls}`),
        signal: new AbortController().signal,
      }
      const override = options?.agent
      return ctx.tools.execute(override === undefined && options !== undefined ? base : { ...base, agent: override ?? agent })
    },
  }
}

/** Pin a supervision mode on a session directly (the log-only event path). */
function supervise(session: Session, mode: 'supervised' | 'unsupervised' = 'supervised'): void {
  session.append('supervision/mode', { mode })
}

interface StoredHook {
  type?: string
  command?: string
  run?: string
  timeout?: number
}

interface StoredGroup {
  name?: string
  matcher?: string
  hooks?: StoredHook[]
}

interface StoredConfig {
  model?: string
  PreToolUse?: StoredGroup[]
  SessionStart?: StoredGroup[]
  Stop?: Array<{ hooks?: StoredHook[] }>
}

function readConfig(cwd: string): StoredConfig {
  return JSON.parse(readFileSync(join(cwd, '.dsh/hooks/claude-code.json'), 'utf8')) as StoredConfig
}

interface HookView {
  name: string
  event: string
  matcher?: string
  command: string
  timeout_seconds?: number
  managed: boolean
}

interface ListShape {
  session: { hooks: HookView[]; changeable: boolean }
  workspace: { hooks: HookView[] }
  global: { hooks: HookView[] }
}

function json(result: ToolExecutionResult): unknown {
  return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

function errorText(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

const ADD_ARGS = {
  name: 'ask-bash',
  event: 'pre_tool',
  matcher: '^bash',
  command: 'printf "%s" "{\\"action\\":\\"ask\\",\\"reason\\":\\"needs a human\\"}"',
  timeout_seconds: 30,
}

const WORKSPACE_ADD = { ...ADD_ARGS, scope: 'workspace' } as const

describe('registration and schema', () => {
  it('registers the three tools', async () => {
    home()
    const mounted = await mount(workspace())
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual(['hook_add', 'hook_remove', 'hook_list'])
  })

  it('exposes the scope parameter on add and remove', async () => {
    home()
    const mounted = await mount(workspace())
    const add = mounted.ctx.tools.schemas().find(schema => schema.name === 'hook_add')
    const addParameters = add?.parameters as unknown as { properties: Record<string, unknown> }
    expect(addParameters.properties).toHaveProperty('scope')
    expect(addParameters.properties).toHaveProperty('command')
    const remove = mounted.ctx.tools.schemas().find(schema => schema.name === 'hook_remove')
    const removeParameters = remove?.parameters as unknown as { properties: Record<string, unknown> }
    expect(removeParameters.properties).toHaveProperty('scope')
  })

  it('applies loader defaults and rejects a non-positive maxHooks config', () => {
    home()
    const registered: string[] = []
    const fake = {
      tools: { register: (definition: { name: string }) => registered.push(definition.name) },
      on: () => () => {},
      get: () => undefined,
    } as unknown as Context
    ToolHooks.apply(fake, {})
    expect(registered).toEqual(['hook_add', 'hook_remove', 'hook_list'])
    expect(() => { ToolHooks.apply(fake, { maxHooks: 0 }) }).toThrow(TypeError)
  })

  it('registers the invariant companion', async () => {
    const register = vi.fn(() => () => {})
    const dispose = await Invariant.apply({ invariants: { register } } as unknown as Context)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-hooks', expect.any(Function))
    dispose()
  })
})

describe('hook_add at workspace scope', () => {
  it('writes the dialect file with a named managed entry and installs the home adapter', async () => {
    const cwd = workspace()
    const homeDir = home()
    const mounted = await mount(cwd)
    const result = await mounted.call('hook_add', WORKSPACE_ADD)
    expect(result.isError).not.toBe(true)
    expect(json(result) as { scope: string; added: HookView; effect: string }).toEqual({
      scope: 'workspace',
      added: {
        name: 'ask-bash',
        event: 'pre_tool',
        matcher: '^bash',
        command: ADD_ARGS.command,
        timeout_seconds: 30,
        managed: true,
      },
      effect: 'runs from the next matching event; an in-flight invocation is unaffected',
    })
    const raw = readConfig(cwd)
    const group = raw.PreToolUse?.[0]
    expect(group?.name).toBe('ask-bash')
    expect(group?.matcher).toBe('^bash')
    expect(group?.hooks?.[0]?.run).toBe(ADD_ARGS.command)
    expect(group?.hooks?.[0]?.timeout).toBe(30)
    expect(readFileSync(homeHookAdapterPath(), 'utf8')).toBe(ADAPTER_SOURCE)
    expect(homeHookAdapterPath()).toBe(join(homeDir, 'hooks', 'tool-hooks-adapter.mjs'))
  })

  it('round-trips through the bridge parser with the matcher, timeout, and adapter command', async () => {
    const cwd = workspace()
    home()
    const mounted = await mount(cwd)
    await mounted.call('hook_add', WORKSPACE_ADD)
    const store = openStore(workspaceHooksDir(cwd))
    const parsed = parseClaudeCodeConfig(JSON.parse(readFileSync(store.configPath, 'utf8')), {})
    expect(parsed.skipped).toEqual([])
    expect(Object.keys(parsed.config)).toEqual(['PreToolUse'])
    const group = (parsed.config.PreToolUse ?? [])[0]
    expect(group?.matcher).toBe('^bash')
    expect(group?.hooks).toHaveLength(1)
    expect(group?.hooks?.[0]?.timeoutSec).toBe(30)
    expect(group?.hooks?.[0]?.command).toBe(bridgeCommand(homeHookAdapterPath(), store.configPath, 'ask-bash'))
    expect(group?.hooks?.[0]?.command).toContain('"ask-bash"')
  })

  it('rejects a duplicate name, a matcher without a subject, a bad regex, a bad timeout, and a blank name', async () => {
    home()
    const mounted = await mount(workspace())
    await mounted.call('hook_add', WORKSPACE_ADD)
    for (const [label, args] of [
      ['duplicate', WORKSPACE_ADD],
      ['matcher on prompt_submit', { ...WORKSPACE_ADD, name: 'p', event: 'prompt_submit', matcher: 'x' }],
      ['bad regex', { ...WORKSPACE_ADD, name: 'r', matcher: '(' }],
      ['bad timeout', { ...WORKSPACE_ADD, name: 't', timeout_seconds: 0 }],
      ['blank name', { ...WORKSPACE_ADD, name: '  ' }],
      ['bad scope', { ...WORKSPACE_ADD, scope: 'planet' }],
    ] as const) {
      const result = await mounted.call('hook_add', args)
      expect(result.isError, label).toBe(true)
    }
  })

  it('enforces the maxHooks bound per store', async () => {
    home()
    const mounted = await mount(workspace(), { maxHooks: 1 })
    await mounted.call('hook_add', WORKSPACE_ADD)
    const result = await mounted.call('hook_add', { ...WORKSPACE_ADD, name: 'second', scope: 'workspace' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('limit 1')
    const otherScope = await mounted.call('hook_add', { ...WORKSPACE_ADD, name: 'third', scope: 'global' })
    expect(otherScope.isError).not.toBe(true)
  })

  it('requires an agent-backed session with a workspace', async () => {
    home()
    const mounted = await mount(workspace())
    const agentless = await mounted.call('hook_add', WORKSPACE_ADD, {})
    expect(agentless.isError).toBe(true)
    const mountedHomeless = await mount(undefined)
    const homeless = await mountedHomeless.call('hook_add', WORKSPACE_ADD)
    expect(homeless.isError).toBe(true)
    const sessionless = await mountedHomeless.call('hook_list', {})
    expect(sessionless.isError).toBe(true)
  })

  it('refuses a corrupted existing file', async () => {
    const cwd = workspace()
    home()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), '{oops', 'utf8')
    const mounted = await mount(cwd)
    const result = await mounted.call('hook_add', WORKSPACE_ADD)
    expect(result.isError).toBe(true)
  })
})

describe('hook_add at session scope', () => {
  it('appends a hook/config snapshot under a pinned supervised session', async () => {
    home()
    const mounted = await mount(workspace())
    supervise(mounted.session)
    const result = await mounted.call('hook_add', ADD_ARGS)
    expect(result.isError).not.toBe(true)
    expect(json(result)).toEqual({
      scope: 'session',
      added: {
        name: 'ask-bash',
        event: 'pre_tool',
        matcher: '^bash',
        command: ADD_ARGS.command,
        timeout_seconds: 30,
        managed: true,
      },
      effect: 'runs from the next matching event; an in-flight invocation is unaffected',
    })
    const last = mounted.session.events.at(-1)
    expect(last?.type).toBe('hook/config')
    expect(readFileSync(homeHookAdapterPath(), 'utf8')).toBe(ADAPTER_SOURCE)
  })

  it('rejects session changes without supervised mode, naming the alternatives', async () => {
    home()
    const failClosed = await mount(workspace())
    const closed = await failClosed.call('hook_add', ADD_ARGS)
    expect(closed.isError).toBe(true)
    expect(errorText(closed)).toContain('supervised')
    const pinned = await mount(workspace())
    supervise(pinned.session, 'unsupervised')
    const rejected = await pinned.call('hook_add', ADD_ARGS)
    expect(rejected.isError).toBe(true)
    const removeToo = await pinned.call('hook_remove', { name: 'ask-bash' })
    expect(removeToo.isError).toBe(true)
  })

  it('allows session changes under a supervised supervision service and denies an unsupervised one', async () => {
    home()
    const supervised = await mount(workspace(), {}, 'supervised')
    expect((await supervised.call('hook_add', ADD_ARGS)).isError).not.toBe(true)
    const unsupervised = await mount(workspace(), {}, 'unsupervised')
    expect((await unsupervised.call('hook_add', ADD_ARGS)).isError).toBe(true)
  })

  it('validates against the folded session set and enforces the session maxHooks bound', async () => {
    home()
    const mounted = await mount(workspace(), { maxHooks: 1 })
    supervise(mounted.session)
    await mounted.call('hook_add', { name: 'ask-bash', event: 'session_start', command: ADD_ARGS.command, timeout_seconds: 30 })
    const duplicate = await mounted.call('hook_add', ADD_ARGS)
    expect(errorText(duplicate)).toContain('already exists in this scope')
    const bound = await mounted.call('hook_add', { name: 'other', event: 'stop', command: ADD_ARGS.command })
    expect(errorText(bound)).toContain('this session already carries')
  })

  it('removes a session hook by folding a new snapshot', async () => {
    home()
    const mounted = await mount(workspace())
    supervise(mounted.session)
    await mounted.call('hook_add', { name: 'ask-bash', event: 'pre_tool', command: ADD_ARGS.command })
    await mounted.call('hook_add', { name: 'log-stop', event: 'stop', command: ADD_ARGS.command })
    const removed = await mounted.call('hook_remove', { name: 'ask-bash' })
    expect(json(removed)).toEqual({
      scope: 'session',
      removed: { name: 'ask-bash', event: 'pre_tool', command: ADD_ARGS.command, managed: true },
    })
    const listed = json(await mounted.call('hook_list', {})) as ListShape
    expect(listed.session.hooks.map(hook => hook.name)).toEqual(['log-stop'])
    const unknown = await mounted.call('hook_remove', { name: 'ask-bash' })
    expect(errorText(unknown)).toContain('no session hook named')
  })
})

describe('global scope', () => {
  it('writes the home hook file and preserves foreign content', async () => {
    const homeDir = home()
    mkdirSync(join(homeDir, 'hooks'), { recursive: true })
    writeFileSync(join(homeDir, 'hooks/claude-code.json'), JSON.stringify({
      model: 'keep-me',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'global-foreign' }] }] },
    }), 'utf8')
    const mounted = await mount(workspace())
    const result = await mounted.call('hook_add', { name: 'ask-bash', event: 'pre_tool', command: ADD_ARGS.command, scope: 'global' })
    expect(result.isError).not.toBe(true)
    const stored = JSON.parse(readFileSync(join(homeDir, 'hooks/claude-code.json'), 'utf8')) as StoredConfig
    expect(stored.model).toBe('keep-me')
    const removed = await mounted.call('hook_remove', { name: 'session_start#1', scope: 'global' })
    expect((json(removed) as { removed: HookView }).removed.managed).toBe(false)
    expect((JSON.parse(readFileSync(join(homeDir, 'hooks/claude-code.json'), 'utf8')) as StoredConfig).model).toBe('keep-me')
    const unknown = await mounted.call('hook_remove', { name: 'missing', scope: 'global' })
    expect(errorText(unknown)).toContain('no global hook named')
  })
})

describe('hook_list across scopes', () => {
  it('groups session, workspace, and global with the supervision gate state', async () => {
    const cwd = workspace()
    home()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'audit' }] }] },
    }), 'utf8')
    const locked = await mount(cwd)
    const before = json(await locked.call('hook_list', {})) as ListShape
    expect(before).toEqual({
      session: { hooks: [], changeable: false },
      workspace: { hooks: [{ name: 'pre_tool#1', event: 'pre_tool', matcher: 'bash', command: 'audit', managed: false }] },
      global: { hooks: [] },
    })
    supervise(locked.session)
    await locked.call('hook_add', { name: 'ask-bash', event: 'pre_tool', command: ADD_ARGS.command })
    const after = json(await locked.call('hook_list', {})) as ListShape
    expect(after.session.changeable).toBe(true)
    expect(after.session.hooks).toEqual([{ name: 'ask-bash', event: 'pre_tool', command: ADD_ARGS.command, managed: true }])
  })

  it('removes a workspace hook within its scope and reports unknown names per scope', async () => {
    const cwd = workspace()
    home()
    const mounted = await mount(cwd)
    await mounted.call('hook_add', WORKSPACE_ADD)
    const removed = await mounted.call('hook_remove', { name: 'ask-bash', scope: 'workspace' })
    expect((json(removed) as { scope: string; removed: HookView }).removed.name).toBe('ask-bash')
    const unknown = await mounted.call('hook_remove', { name: 'ask-bash', scope: 'workspace' })
    expect(errorText(unknown)).toContain('no workspace hook named')
    expect(readConfig(cwd).PreToolUse).toBeUndefined()
  })

  it('classifies list as concurrency-safe and the writers as exclusive', async () => {
    home()
    const mounted = await mount(workspace())
    expect(mounted.ctx.tools.executionMode({ name: 'hook_list', arguments: {}, callId: CallId('mode-a'), signal: new AbortController().signal })).toEqual({ kind: 'parallel' })
    expect(mounted.ctx.tools.executionMode({ name: 'hook_add', arguments: {}, callId: CallId('mode-b'), signal: new AbortController().signal })).toEqual({ kind: 'exclusive' })
  })
})

describe('subagent inheritance', () => {
  class FakeAgents extends Service {
    private readonly entries = new Map<SessionId, Agent>()
    constructor(ctx: Context) {
      super(ctx, 'agents')
    }
    register(agent: Agent): void {
      this.entries.set(agent.id, agent)
    }
    get(id: SessionId): Agent | undefined {
      return this.entries.get(id)
    }
  }

  async function seeded(parent: Session, child: Session): Promise<void> {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolHooks)
    await ctx.plugin(FakeAgents)
    const parentAgent = fakeAgent(parent)
    const childAgent = fakeAgent(child)
    ;(ctx.get('agents') as unknown as FakeAgents).register(childAgent)
    ctx.emit(scopeTarget(ctx as unknown as SubagentRuntime, parentAgent), 'subagent/start', {
      runId: SubagentRunId('run-1'),
      provider: 'inproc',
      id: child.id,
      local: false,
    })
  }

  function sessionWith(): Session {
    home()
    const session = Session.create(SessionId('parent'))
    return session
  }

  it('seeds a fresh child with the parent\'s folded session hooks once', async () => {
    const parent = sessionWith()
    parent.append('hook/config', { hooks: [{ name: 'ask-bash', event: 'pre_tool', command: 'ask' }] })
    const child = Session.create(SessionId('child'))
    await seeded(parent, child)
    const last = child.events.at(-1)
    expect(last?.type).toBe('hook/config')
    if (last?.type === 'hook/config') {
      expect(last.data.source).toBe('delegation')
      expect(last.data.hooks).toEqual([{ name: 'ask-bash', event: 'pre_tool', command: 'ask' }])
    }
  })

  it('does not seed when the parent carries no session hooks, the child already has a set, or the child is unknown', async () => {
    const emptyParent = sessionWith()
    const freshChild = Session.create(SessionId('child'))
    await seeded(emptyParent, freshChild)
    expect(freshChild.events.some(event => event.type === 'hook/config')).toBe(false)

    const parent = sessionWith()
    parent.append('hook/config', { hooks: [{ name: 'a', event: 'stop', command: 'c' }] })
    const settled = Session.create(SessionId('child'))
    settled.append('hook/config', { hooks: [] })
    await seeded(parent, settled)
    expect(settled.events.filter(event => event.type === 'hook/config')).toHaveLength(1)

    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolHooks)
    ctx.emit(scopeTarget(ctx as unknown as SubagentRuntime, fakeAgent(parent)), 'subagent/start', {
      runId: SubagentRunId('run-2'),
      provider: 'inproc',
      id: SessionId('ghost'),
      local: false,
    })
    ctx.emit(scopeTarget(ctx as unknown as SubagentRuntime, undefined), 'subagent/start', {
      runId: SubagentRunId('run-3'),
      provider: 'inproc',
      id: SessionId('ghost-2'),
      local: false,
    })
    expect(parent.events.filter(event => event.type === 'hook/config')).toHaveLength(1)
  })
})

describe('store edge cases', () => {
  it('rejects invalid JSON, non-object roots, and non-object hooks values', () => {
    for (const [label, text] of [
      ['invalid json', '{oops'],
      ['array root', '[]'],
    ] as const) {
      const cwd = workspace()
      const file = join(cwd, '.dsh/hooks/claude-code.json')
      mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
      writeFileSync(file, text, 'utf8')
      expect(() => { openStore(workspaceHooksDir(cwd)) }, label).toThrow()
    }
  })

  it('adds into a bare event-map file and removes the last group cleanly', () => {
    const cwd = workspace()
    const file = join(cwd, '.dsh/hooks/claude-code.json')
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(file, '{"Stop":[{"hooks":[{"type":"command","command":"keep-going"}]}]}', 'utf8')
    const store = openStore(workspaceHooksDir(cwd))
    expect(store.bare).toBe(true)
    addEntry(store, { name: 'n', event: 'pre_tool', command: 'c' }, 'bridge-cmd')
    expect(() => { addEntry(store, { name: 'n', event: 'stop', command: 'c' }, 'bridge-cmd') }).toThrow(/already exists/)
    writeStore(store)
    const reread = openStore(workspaceHooksDir(cwd))
    expect(listEntries(reread).map(entry => entry.name)).toEqual(['n', 'stop#1'])
    expect(removeEntry(reread, 'n')).toBeDefined()
    expect(removeEntry(reread, 'missing')).toBeUndefined()
    const multi = openStore(workspaceHooksDir(cwd))
    addEntry(multi, { name: 'first', event: 'stop', command: 'a' }, 'cmd-a')
    addEntry(multi, { name: 'second', event: 'stop', command: 'b' }, 'cmd-b')
    expect(removeEntry(multi, 'second')?.name).toBe('second')
    expect(listEntries(multi).map(entry => entry.name)).toEqual(['n', 'stop#1', 'first'])
    writeStore(reread)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'keep-going' }] }],
    })
  })
})

describe('listing edge shapes', () => {
  it('skips disabled groups, joins multi-command groups, and ignores non-array event values', () => {
    const cwd = workspace()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'bash', disabled: true, hooks: [{ type: 'command', command: 'skipped' }] },
          { matcher: 'bash', hooks: [{ type: 'command', command: 'one' }, { type: 'command', command: 'two' }] },
        ],
        SessionStart: 'not-an-array',
      },
    }), 'utf8')
    const store = openStore(workspaceHooksDir(cwd))
    expect(listEntries(store)).toEqual([
      { name: 'pre_tool#2', event: 'pre_tool', matcher: 'bash', command: 'one ; two', managed: false },
    ])
  })
})

describe('unusable group shapes', () => {
  it('skips non-object groups, non-array hooks, and command-less groups when listing and removing', () => {
    const cwd = workspace()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          42,
          { hooks: 'not-an-array' },
          { hooks: [{ type: 'command' }] },
          { hooks: [null, { type: 'command', command: 'real' }] },
        ],
      },
    }), 'utf8')
    const store = openStore(workspaceHooksDir(cwd))
    expect(listEntries(store)).toEqual([
      { name: 'pre_tool#4', event: 'pre_tool', command: 'real', managed: false },
    ])
    expect(removeEntry(store, 'pre_tool#4')?.name).toBe('pre_tool#4')
    expect(listEntries(store)).toEqual([])
  })
})

describe('the adapter script', () => {
  function runAdapter(argv: string[], payload: string) {
    const cwd = workspace()
    const adapterPath = join(cwd, 'tool-hooks-adapter.mjs')
    installAdapter(adapterPath)
    return spawnSync(process.execPath, [adapterPath, ...argv], { input: payload, encoding: 'utf8' })
  }

  function writeManagedConfig(root: unknown): string {
    const cwd = workspace()
    const configPath = join(cwd, '.dsh/hooks/claude-code.json')
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(root), 'utf8')
    return configPath
  }

  const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'ls' } })

  it('maps the ask action to the dialect permission envelope', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'ask', hooks: [{ type: 'command', command: 'printf "%s" "{\\"action\\":\\"ask\\",\\"reason\\":\\"needs a human\\"}"', run: 'printf "%s" "{\\"action\\":\\"ask\\",\\"reason\\":\\"needs a human\\"}"' }] }] } })
    const run = runAdapter([configPath, 'ask'], PAYLOAD)
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'needs a human',
      },
    })
  })

  it('maps allow and deny actions and a bare context injection', () => {
    const allow = writeManagedConfig({ hooks: { SessionStart: [{ name: 'a', hooks: [{ command: 'x', run: 'printf "%s" "{\\"action\\":\\"allow\\"}"' }] }] } })
    expect(JSON.parse(runAdapter([allow, 'a'], JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', permissionDecision: 'allow' } })
    const deny = writeManagedConfig({ hooks: { PostToolUse: [{ name: 'd', hooks: [{ command: 'x', run: 'printf "%s" "{\\"action\\":\\"deny\\",\\"reason\\":\\"nope\\"}"' }] }] } })
    expect(JSON.parse(runAdapter([deny, 'd'], JSON.stringify({ hook_event_name: 'PostToolUse' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } })
    const context = writeManagedConfig({ hooks: { UserPromptSubmit: [{ name: 'c', hooks: [{ command: 'x', run: 'printf "%s" "{\\"context\\":\\"extra reading\\"}"' }] }] } })
    expect(JSON.parse(runAdapter([context, 'c'], JSON.stringify({ hook_event_name: 'UserPromptSubmit' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'extra reading' } })
  })

  it('passes plain text and non-zero exits through untouched', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'p', hooks: [{ command: 'x', run: 'printf plain-observation' }] }] } })
    const plain = runAdapter([configPath, 'p'], PAYLOAD)
    expect(plain.status).toBe(0)
    expect(plain.stdout).toBe('plain-observation')
    const failing = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'f', hooks: [{ command: 'x', run: 'printf oops >&2; exit 3' }] }] } })
    const failed = runAdapter([failing, 'f'], PAYLOAD)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain('oops')
  })

  it('emits a decision even when the payload is not JSON', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'a', hooks: [{ command: 'x', run: 'printf "%s" "{\\"action\\":\\"deny\\"}"' }] }] } })
    const run = runAdapter([configPath, 'a'], 'not-json')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('fails clearly for a missing name or unreadable config', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'a', hooks: [{ command: 'x', run: 'true' }] }] } })
    expect(runAdapter([configPath, 'missing'], PAYLOAD).status).toBe(1)
    expect(runAdapter([join(workspace(), 'none.json'), 'a'], PAYLOAD).status).toBe(1)
  })

  it('runs an inline session command from --run argv', () => {
    const run = runAdapter(['--run', 'printf "%s" "{\\"context\\":\\"from the session layer\\"}"'], JSON.stringify({ hook_event_name: 'UserPromptSubmit' }))
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'from the session layer' },
    })
    const plain = runAdapter(['--run', 'printf session-observed'], PAYLOAD)
    expect(plain.status).toBe(0)
    expect(plain.stdout).toBe('session-observed')
    expect(runAdapter(['--run', ''], PAYLOAD).status).toBe(1)
    expect(runAdapter([], PAYLOAD).status).toBe(1)
  })

  it('installs idempotently and quotes paths with spaces in the bridge command', () => {
    const dir = workspace()
    const adapterPath = join(dir, 'with space', 'adapter.mjs')
    installAdapter(adapterPath)
    installAdapter(adapterPath)
    expect(readFileSync(adapterPath, 'utf8')).toBe(ADAPTER_SOURCE)
    expect(bridgeCommand(adapterPath, join(dir, 'config file.json'), 'a b'))
      .toBe(`node "${join(dir, 'with space', 'adapter.mjs')}" "${join(dir, 'config file.json')}" "a b"`)
  })
})
