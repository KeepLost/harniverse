import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { parseClaudeCodeConfig } from '@deepseek-ai/dsh-hooks-claude-code/src/config.ts'
import * as ToolHooks from '../src/index.ts'
import { ADAPTER_SOURCE, bridgeCommand, installAdapter } from '../src/adapter.ts'
import { addEntry, listEntries, openStore, removeEntry, writeStore } from '../src/store.ts'
import * as Invariant from '../src/invariant.ts'

const activeContexts: Context[] = []
const activeDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-hooks-'))
  activeDirs.push(dir)
  return dir
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

async function mount(cwd: string | undefined, config: ToolHooks.Config = {}): Promise<{
  ctx: Context
  call: (tool: string, args: unknown, options?: { agent?: Agent }) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolHooks, config)
  let calls = 0
  const session = ctx.sessions.create(SessionId('caller'), {
    meta: { createdAt: 1, ...cwd === undefined ? {} : { cwd } },
  })
  const agent = fakeAgent(session)
  return {
    ctx,
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

describe('registration and schema', () => {
  it('registers the three tools', async () => {
    const mounted = await mount(workspace())
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual(['hook_add', 'hook_remove', 'hook_list'])
  })

  it('applies loader defaults and rejects a non-positive maxHooks config', () => {
    const registered: string[] = []
    const fake = {
      tools: { register: (definition: { name: string }) => registered.push(definition.name) },
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

describe('hook_add', () => {
  it('writes the dialect file with a named managed entry and installs the adapter', async () => {
    const cwd = workspace()
    const mounted = await mount(cwd)
    const result = await mounted.call('hook_add', ADD_ARGS)
    expect(result.isError).not.toBe(true)
    expect(json(result) as { added: HookView; effect: string }).toEqual({
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
    expect(readFileSync(join(cwd, '.dsh/hooks/tool-hooks-adapter.mjs'), 'utf8')).toBe(ADAPTER_SOURCE)
  })

  it('round-trips through the bridge parser with the matcher, timeout, and adapter command', async () => {
    const cwd = workspace()
    const mounted = await mount(cwd)
    await mounted.call('hook_add', ADD_ARGS)
    const store = openStore(cwd)
    const parsed = parseClaudeCodeConfig(JSON.parse(readFileSync(store.configPath, 'utf8')), {})
    expect(parsed.skipped).toEqual([])
    expect(Object.keys(parsed.config)).toEqual(['PreToolUse'])
    const group = (parsed.config.PreToolUse ?? [])[0]
    expect(group?.matcher).toBe('^bash')
    expect(group?.hooks).toHaveLength(1)
    expect(group?.hooks?.[0]?.timeoutSec).toBe(30)
    expect(group?.hooks?.[0]?.command).toBe(bridgeCommand(store.adapterPath, store.configPath, 'ask-bash'))
    expect(group?.hooks?.[0]?.command).toContain('"ask-bash"')
  })

  it('rejects a duplicate name, a matcher without a subject, a bad regex, a bad timeout, and a blank name', async () => {
    const mounted = await mount(workspace())
    await mounted.call('hook_add', ADD_ARGS)
    for (const [label, args] of [
      ['duplicate', ADD_ARGS],
      ['matcher on prompt_submit', { ...ADD_ARGS, name: 'p', event: 'prompt_submit', matcher: 'x' }],
      ['bad regex', { ...ADD_ARGS, name: 'r', matcher: '(' }],
      ['bad timeout', { ...ADD_ARGS, name: 't', timeout_seconds: 0 }],
      ['blank name', { ...ADD_ARGS, name: '  ' }],
    ] as const) {
      const result = await mounted.call('hook_add', args)
      expect(result.isError, label).toBe(true)
    }
  })

  it('enforces the maxHooks bound', async () => {
    const cwd = workspace()
    const mounted = await mount(cwd, { maxHooks: 1 })
    await mounted.call('hook_add', ADD_ARGS)
    const result = await mounted.call('hook_add', { ...ADD_ARGS, name: 'second' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('limit 1')
  })

  it('requires an agent-backed session with a workspace', async () => {
    const mounted = await mount(workspace())
    const agentless = await mounted.call('hook_add', ADD_ARGS, {})
    expect(agentless.isError).toBe(true)
    const mountedHomeless = await mount(undefined)
    const homeless = await mountedHomeless.call('hook_add', ADD_ARGS)
    expect(homeless.isError).toBe(true)
  })

  it('refuses a corrupted existing file', async () => {
    const cwd = workspace()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), '{oops', 'utf8')
    const mounted = await mount(cwd)
    const result = await mounted.call('hook_add', ADD_ARGS)
    expect(result.isError).toBe(true)
  })
})

describe('hook_list and hook_remove', () => {
  it('lists managed and foreign entries with derived positional names', async () => {
    const cwd = workspace()
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(join(cwd, '.dsh/hooks/claude-code.json'), JSON.stringify({
      model: 'gpt-x',
      hooks: {
        PreToolUse: [
          { matcher: 'bash', hooks: [{ type: 'command', command: 'audit-one' }, { type: 'command', command: 'audit-two' }] },
          { disabled: true, matcher: 'bash', hooks: [{ type: 'command', command: 'skipped' }] },
        ],
        UserPromptSubmit: [{ matcher: 'ignored-anyway', hooks: [{ type: 'command', command: 'see-prompt' }] }],
      },
    }), 'utf8')
    const mounted = await mount(cwd)
    const listed = json(await mounted.call('hook_list', {})) as { hooks: HookView[] }
    expect(listed.hooks).toEqual([
      { name: 'pre_tool#1', event: 'pre_tool', matcher: 'bash', command: 'audit-one ; audit-two', managed: false },
      { name: 'prompt_submit#1', event: 'prompt_submit', command: 'see-prompt', managed: false },
    ])
    const removed = await mounted.call('hook_remove', { name: 'pre_tool#1' })
    expect((json(removed) as { removed: HookView }).removed.managed).toBe(false)
    const after = json(await mounted.call('hook_list', {})) as { hooks: HookView[] }
    expect(after.hooks).toEqual([
      { name: 'prompt_submit#1', event: 'prompt_submit', command: 'see-prompt', managed: false },
    ])
    expect(readConfig(cwd).model).toBe('gpt-x')
  })

  it('removes a managed hook and reports unknown names', async () => {
    const cwd = workspace()
    const mounted = await mount(cwd)
    await mounted.call('hook_add', ADD_ARGS)
    const removed = await mounted.call('hook_remove', { name: 'ask-bash' })
    expect((json(removed) as { removed: HookView }).removed.name).toBe('ask-bash')
    expect((json(await mounted.call('hook_list', {})) as { hooks: HookView[] }).hooks).toEqual([])
    const unknown = await mounted.call('hook_remove', { name: 'ask-bash' })
    expect(unknown.isError).toBe(true)
    expect(errorText(unknown)).toContain('hook_list')
  })

  it('lists empty on a fresh workspace and classifies list as concurrency-safe', async () => {
    const mounted = await mount(workspace())
    expect(json(await mounted.call('hook_list', {}))).toEqual({ hooks: [] })
    expect(mounted.ctx.tools.executionMode({ name: 'hook_list', arguments: {}, callId: CallId('mode-a'), signal: new AbortController().signal })).toEqual({ kind: 'parallel' })
    expect(mounted.ctx.tools.executionMode({ name: 'hook_add', arguments: {}, callId: CallId('mode-b'), signal: new AbortController().signal })).toEqual({ kind: 'exclusive' })
  })

  it('adds a minimal hook with neither matcher nor timeout', async () => {
    const cwd = workspace()
    const mounted = await mount(cwd)
    const result = await mounted.call('hook_add', { name: 'log-start', event: 'session_start', command: 'logger one' })
    expect((json(result) as { added: HookView }).added).toEqual({ name: 'log-start', event: 'session_start', command: 'logger one', managed: true })
    const raw = readConfig(cwd)
    expect(raw.SessionStart?.[0]?.hooks?.[0]?.run).toBe('logger one')
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
      expect(() => { openStore(cwd) }, label).toThrow()
    }
  })

  it('adds into a bare event-map file and removes the last group cleanly', () => {
    const cwd = workspace()
    const file = join(cwd, '.dsh/hooks/claude-code.json')
    mkdirSync(join(cwd, '.dsh/hooks'), { recursive: true })
    writeFileSync(file, '{"Stop":[{"hooks":[{"type":"command","command":"keep-going"}]}]}', 'utf8')
    const store = openStore(cwd)
    expect(store.bare).toBe(true)
    addEntry(store, { name: 'n', event: 'pre_tool', command: 'c' }, 'bridge-cmd')
    expect(() => { addEntry(store, { name: 'n', event: 'stop', command: 'c' }, 'bridge-cmd') }).toThrow(/already exists/)
    writeStore(store)
    const reread = openStore(cwd)
    expect(listEntries(reread).map(entry => entry.name)).toEqual(['n', 'stop#1'])
    expect(removeEntry(reread, 'n')).toBeDefined()
    expect(removeEntry(reread, 'missing')).toBeUndefined()
    const multi = openStore(cwd)
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
    const store = openStore(cwd)
    expect(listEntries(store)).toEqual([
      { name: 'pre_tool#4', event: 'pre_tool', command: 'real', managed: false },
    ])
    expect(removeEntry(store, 'pre_tool#4')?.name).toBe('pre_tool#4')
    expect(listEntries(store)).toEqual([])
  })
})

describe('the adapter script', () => {
  function runAdapter(configPath: string, name: string, payload: string) {
    const cwd = workspace()
    const adapterPath = join(cwd, 'tool-hooks-adapter.mjs')
    installAdapter(adapterPath)
    return spawnSync(process.execPath, [adapterPath, configPath, name], { input: payload, encoding: 'utf8' })
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
    const run = runAdapter(configPath, 'ask', PAYLOAD)
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
    expect(JSON.parse(runAdapter(allow, 'a', JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', permissionDecision: 'allow' } })
    const deny = writeManagedConfig({ hooks: { PostToolUse: [{ name: 'd', hooks: [{ command: 'x', run: 'printf "%s" "{\\"action\\":\\"deny\\",\\"reason\\":\\"nope\\"}"' }] }] } })
    expect(JSON.parse(runAdapter(deny, 'd', JSON.stringify({ hook_event_name: 'PostToolUse' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } })
    const context = writeManagedConfig({ UserPromptSubmit: [{ name: 'c', hooks: [{ command: 'x', run: 'printf "%s" "{\\"context\\":\\"extra reading\\"}"' }] }] })
    expect(JSON.parse(runAdapter(context, 'c', JSON.stringify({ hook_event_name: 'UserPromptSubmit' })).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'extra reading' } })
  })

  it('passes plain text and non-zero exits through untouched', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'p', hooks: [{ command: 'x', run: 'printf plain-observation' }] }] } })
    const plain = runAdapter(configPath, 'p', PAYLOAD)
    expect(plain.status).toBe(0)
    expect(plain.stdout).toBe('plain-observation')
    const failing = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'f', hooks: [{ command: 'x', run: 'printf oops >&2; exit 3' }] }] } })
    const failed = runAdapter(failing, 'f', PAYLOAD)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain('oops')
  })

  it('emits a decision even when the payload is not JSON', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'a', hooks: [{ command: 'x', run: 'printf "%s" "{\\"action\\":\\"deny\\"}"' }] }] } })
    const run = runAdapter(configPath, 'a', 'not-json')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('fails clearly for a missing name or unreadable config', () => {
    const configPath = writeManagedConfig({ hooks: { PreToolUse: [{ name: 'a', hooks: [{ command: 'x', run: 'true' }] }] } })
    expect(runAdapter(configPath, 'missing', PAYLOAD).status).toBe(1)
    expect(runAdapter(join(workspace(), 'none.json'), 'a', PAYLOAD).status).toBe(1)
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
