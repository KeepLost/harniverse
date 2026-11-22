/**
 * Model-facing hook tools: `hook_add`, `hook_remove`, and `hook_list`. A hook
 * is a shell command that runs automatically at a lifecycle point and can gate,
 * enrich, or observe the agent. Hooks live at one of three scopes: `session`
 * (this conversation only, held in the session log and inherited by subagents),
 * `workspace` (shared by every session in the workspace directory, held in the
 * project hook file), and `global` (shared by every session for this user, held
 * in the home hook file). The bridges fold the session layer first and re-read
 * the files at every event, so every change takes effect from the next matching
 * event — mid-conversation, no reload — while the model-facing surface exposes
 * neither files nor dialect: names, plain events, and a simple JSON action
 * contract. Session-scope changes require supervised mode; unsupervised
 * sessions are refused so a conversation cannot silently re-arm itself.
 *
 * @module @deepseek-ai/dsh-tool-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  foldSessionHooks,
  homeHookAdapterPath,
  type PortableHookEvent,
  type SessionHookSpec,
} from '@deepseek-ai/dsh-hook-protocol'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { effectiveSupervisionMode } from '@deepseek-ai/dsh-supervision'
// Pulls in the declaration-merged supervision service and subagent lifecycle
// events the tool reads opportunistically.
import type {} from '@deepseek-ai/dsh-supervision'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { bridgeCommand, installAdapter } from './adapter.ts'
import {
  addEntry,
  CC_EVENT,
  type HookEntry,
  listEntries,
  MATCHER_EVENTS,
  openStore,
  removeEntry,
  workspaceHooksDir,
  writeStore,
} from './store.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-hooks'

/** Capability service required to register the model-facing tools. */
export const inject = ['tools']

import { DEFAULT_MAX_HOOKS, MAX_TIMEOUT_SECONDS, SCOPE_VALUES } from './limits.ts'

/** Where an installed hook lives; also the removal and listing selector. */
export type HookScope = 'session' | 'workspace' | 'global'

/** Deployment-owned bounds on how many hooks each scope's store may carry. */
export interface Config {
  /** Maximum total hook groups (managed plus foreign) kept in one scope's store. Defaults to 256. */
  maxHooks?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxHooks: z.number().step(1).min(1).default(DEFAULT_MAX_HOOKS),
})

interface ResolvedConfig {
  readonly maxHooks: number
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxHooks = config.maxHooks ?? DEFAULT_MAX_HOOKS
  if (!Number.isInteger(maxHooks) || maxHooks < 1) {
    throw new TypeError('tool-hooks: maxHooks must be a positive integer')
  }
  return { maxHooks }
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

const EVENT_VALUES = Object.keys(CC_EVENT) as PortableHookEvent[]

const SCOPE_DESCRIPTION = 'Where the hook lives: "session" follows only this conversation (inherited by its subagents; '
  + 'changing session hooks requires supervised mode); "workspace" is shared by every session opened in this workspace '
  + 'directory; "global" is shared by every session for this user. Defaults to "session".'

const ADD_PARAMETERS = {
  name: {
    type: 'string',
    required: true,
    description: 'Stable identifier for this hook, unique within its scope. hook_list shows it; hook_remove uses it.',
  },
  event: {
    type: 'string',
    enum: EVENT_VALUES,
    required: true,
    description: 'When the command runs: pre_tool and post_tool surround each tool call; prompt_submit fires on every '
      + 'submitted user prompt; session_start runs once when the session opens; stop runs when the agent finishes a turn; '
      + 'subagent_start and subagent_stop run when a subagent opens or closes.',
  },
  scope: {
    type: 'string',
    enum: SCOPE_VALUES,
    description: SCOPE_DESCRIPTION,
  },
  matcher: {
    type: 'string',
    description: 'Unanchored regex tested against the subject: the tool name (pre_tool/post_tool), the session-start '
      + 'source ("startup" or "resume"), or the subagent type. Omit to run on everything. Not valid for prompt_submit or stop.',
  },
  command: {
    type: 'string',
    required: true,
    description: 'Shell command, run in the session workspace with the event details as JSON on stdin: session_id, cwd, '
      + 'hook_event_name, plus tool_name/tool_input/tool_use_id (tool events), prompt (prompt_submit), tool_response '
      + '(post_tool), or source (session_start). To only observe and log, print nothing or plain text. To act, exit 0 and '
      + 'print one JSON object: {"action":"deny","reason":"why"} blocks the call or prompt; {"action":"ask","reason":"why"} '
      + 'asks the user to approve first (pre_tool only); {"action":"allow"} permits it (pre_tool only); {"context":"text"} '
      + 'injects text into the conversation (session_start, prompt_submit, post_tool). A non-zero exit also blocks, with '
      + 'stderr as the reason.',
  },
  timeout_seconds: {
    type: 'number',
    description: `Kill the command after this many seconds (1 through ${MAX_TIMEOUT_SECONDS}). Defaults to ${MAX_TIMEOUT_SECONDS}.`,
  },
} as const

const REMOVE_PARAMETERS = {
  name: {
    type: 'string',
    required: true,
    description: 'The hook to remove, exactly as hook_list names it.',
  },
  scope: {
    type: 'string',
    enum: SCOPE_VALUES,
    description: 'Which scope to remove from; the name is resolved within that scope alone. Defaults to "session".',
  },
} as const

const LIST_PARAMETERS = {}

/** The model-facing view of one listed hook (no file paths, no dialect names). */
type HookView = {
  name: string
  event: PortableHookEvent
  matcher?: string
  command: string
  timeout_seconds?: number
  managed: boolean
}

function viewOf(entry: HookEntry): HookView {
  return {
    name: entry.name,
    event: entry.event,
    ...entry.matcher !== undefined ? { matcher: entry.matcher } : {},
    command: entry.command,
    ...entry.timeoutSeconds !== undefined ? { timeout_seconds: entry.timeoutSeconds } : {},
    managed: entry.managed,
  }
}

/** The model-facing view of one session-held hook. */
function viewOfSpec(spec: SessionHookSpec): HookView {
  return {
    name: spec.name,
    event: spec.event,
    ...spec.matcher !== undefined ? { matcher: spec.matcher } : {},
    command: spec.command,
    ...spec.timeoutSec !== undefined ? { timeout_seconds: spec.timeoutSec } : {},
    managed: true,
  }
}

/** The agent-backed session every scope operates on. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('hook tools require an agent-backed session')
  return exec.agent
}

/** The session workspace the workspace scope operates on; agent-backed sessions always have one. */
function requireCwd(exec: ToolExecution): string {
  const cwd = requireAgent(exec).session.header.cwd
  if (cwd === undefined || cwd.length === 0) throw new Error('the session has no workspace directory, so workspace hooks cannot be managed')
  return cwd
}

/** Whether the executing session may change session-scope hooks (supervised only, fail-closed). */
function sessionChangesAllowed(ctx: Context, agent: Agent): boolean {
  const service = ctx.get('supervision')
  const mode = service !== undefined
    ? service.modeOf(agent.session)
    : effectiveSupervisionMode(agent.session.events) ?? 'unsupervised'
  return mode === 'supervised'
}

/** Reject a session-scope change attempted outside supervised mode. */
function requireSupervised(ctx: Context, agent: Agent): void {
  if (!sessionChangesAllowed(ctx, agent)) {
    throw new Error('session hooks can only be changed while the session is supervised; this one is unsupervised. '
      + 'Ask the user to switch supervision on, or install the hook at workspace or global scope instead')
  }
}

/** Validate one add call against the scope's existing entries before anything is written. */
function validateAdd(input: {
  name: string
  event: PortableHookEvent
  matcher?: string
  timeoutSeconds?: number
}, names: readonly string[]): void {
  if (input.name.trim().length === 0) throw new Error('name must be a non-empty string')
  if (input.timeoutSeconds !== undefined
    && (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
    throw new Error(`timeout_seconds must be a whole number from 1 through ${MAX_TIMEOUT_SECONDS}`)
  }
  if (input.matcher !== undefined) {
    if (!MATCHER_EVENTS.includes(input.event)) {
      throw new Error(`matcher applies only to ${MATCHER_EVENTS.join(', ')} — ${input.event} has no match subject`)
    }
    try {
      void new RegExp(input.matcher)
    } catch {
      throw new Error(`matcher is not a valid regular expression: ${input.matcher}`)
    }
  }
  if (names.includes(input.name)) {
    throw new Error(`a hook named "${input.name}" already exists in this scope; remove it first with hook_remove`)
  }
}

/** Seed a fresh child with the delegating parent's session hooks (once, at subagent start). */
function seedSubagentHooks(ctx: Context): void {
  ctx.on('subagent/start', function (this: unknown, info: SubagentRunInfo) {
    const parent = carrierKeyOf(this) as Agent | undefined
    const child = ctx.get('agents')?.get(info.id)
    if (parent === undefined || child === undefined) return
    const inherited = foldSessionHooks(parent.session.events)
    const childManaged = child.session.events.some(event => event.type === 'hook/config')
    if (inherited.length === 0 || childManaged) return
    child.session.append('hook/config', { hooks: [...inherited], source: 'delegation' })
  }, { global: true })
}

/** Register the hook tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  seedSubagentHooks(ctx)

  ctx.tools.register(defineTool({
    name: 'hook_add',
    description: 'Install a hook: a shell command that runs automatically at a lifecycle point and can gate, enrich, or '
      + 'observe the agent — for example, ask the user before every bash call, or log each web fetch. Scope selects where '
      + 'it lives: session (this conversation, inherited by subagents, supervised mode required), workspace (every session '
      + 'in this directory), or global (every session for this user); the default is session. Takes effect from the next '
      + 'matching event; every run is recorded in the session log. List with hook_list, remove with hook_remove.',
    parameters: ADD_PARAMETERS,
    output: JSON_OUTPUT,
    execute: (args, exec) => Promise.resolve().then(() => {
      const scope: HookScope = args.scope ?? 'session'
      const entry = {
        name: args.name,
        event: args.event,
        ...args.matcher !== undefined ? { matcher: args.matcher } : {},
        command: args.command,
        ...args.timeout_seconds !== undefined ? { timeoutSeconds: args.timeout_seconds } : {},
      }
      if (scope === 'session') {
        const agent = requireAgent(exec)
        requireSupervised(ctx, agent)
        const specs = foldSessionHooks(agent.session.events)
        validateAdd(entry, specs.map(spec => spec.name))
        if (specs.length >= resolved.maxHooks) {
          throw new Error(`this session already carries ${specs.length} hooks (limit ${resolved.maxHooks}); remove some first`)
        }
        const spec: SessionHookSpec = {
          name: entry.name,
          event: entry.event,
          ...entry.matcher !== undefined ? { matcher: entry.matcher } : {},
          command: entry.command,
          ...entry.timeoutSeconds !== undefined ? { timeoutSec: entry.timeoutSeconds } : {},
        }
        installAdapter(homeHookAdapterPath())
        agent.session.append('hook/config', { hooks: [...specs, spec] })
        return {
          scope,
          added: viewOfSpec(spec),
          effect: 'runs from the next matching event; an in-flight invocation is unaffected',
        }
      }
      const store = openStore(scope === 'workspace' ? workspaceHooksDir(requireCwd(exec)) : dshHomePath('hooks'))
      const entries = listEntries(store)
      validateAdd(entry, entries.map(candidate => candidate.name))
      if (entries.length >= resolved.maxHooks) {
        throw new Error(`this ${scope} already carries ${entries.length} hooks (limit ${resolved.maxHooks}); remove some first`)
      }
      const adapterPath = homeHookAdapterPath()
      installAdapter(adapterPath)
      addEntry(store, entry, bridgeCommand(adapterPath, store.configPath, entry.name))
      writeStore(store)
      return {
        scope,
        added: viewOf({ ...entry, managed: true }),
        effect: 'runs from the next matching event; an in-flight invocation is unaffected',
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'hook_remove',
    description: 'Remove one hook by the name hook_list shows, within one scope (default session; session removal requires '
      + 'supervised mode). Takes effect from the next matching event; an already-running invocation is unaffected.',
    parameters: REMOVE_PARAMETERS,
    output: JSON_OUTPUT,
    execute: (args, exec) => Promise.resolve().then(() => {
      const scope: HookScope = args.scope ?? 'session'
      if (scope === 'session') {
        const agent = requireAgent(exec)
        requireSupervised(ctx, agent)
        const specs = foldSessionHooks(agent.session.events)
        const removed = specs.find(spec => spec.name === args.name)
        if (removed === undefined) {
          throw new Error(`no session hook named "${args.name}"; call hook_list for every scope's current names`)
        }
        agent.session.append('hook/config', { hooks: specs.filter(spec => spec.name !== args.name) })
        return { scope, removed: viewOfSpec(removed) }
      }
      const store = openStore(scope === 'workspace' ? workspaceHooksDir(requireCwd(exec)) : dshHomePath('hooks'))
      const removed = removeEntry(store, args.name)
      if (removed === undefined) {
        throw new Error(`no ${scope} hook named "${args.name}"; call hook_list for every scope's current names`)
      }
      writeStore(store)
      return { scope, removed: viewOf(removed) }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'hook_list',
    description: "List every hook by scope — session (this conversation; 'changeable' reports whether supervised mode "
      + "allows changes), workspace, and global. Names shaped like 'pre_tool#1' are hand-written file entries the tools "
      + 'did not install; remove and reinstall them to manage them through the tools.',
    parameters: LIST_PARAMETERS,
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (_args, exec) => Promise.resolve().then(() => {
      const agent = requireAgent(exec)
      const workspaceStore = openStore(workspaceHooksDir(requireCwd(exec)))
      const globalStore = openStore(dshHomePath('hooks'))
      return {
        session: {
          hooks: foldSessionHooks(agent.session.events).map(viewOfSpec),
          changeable: sessionChangesAllowed(ctx, agent),
        },
        workspace: { hooks: listEntries(workspaceStore).map(viewOf) },
        global: { hooks: listEntries(globalStore).map(viewOf) },
      }
    }),
  }))
}
