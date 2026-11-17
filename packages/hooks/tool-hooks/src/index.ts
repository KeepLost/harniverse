/**
 * Model-facing workspace hook tools: `hook_add`, `hook_remove`, and `hook_list`.
 * A hook is a shell command that runs automatically at a lifecycle point and can
 * gate, enrich, or observe the agent. The tools manage the Claude-Code-dialect
 * project-layer file the `dsh-hooks-claude-code` bridge re-reads at every event,
 * so an install or removal takes effect from the next matching event — mid-session,
 * no reload — while the model-facing surface exposes neither the file nor the
 * dialect: names, plain events, and a simple JSON action contract.
 *
 * @module @deepseek-ai/dsh-tool-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { bridgeCommand, installAdapter } from './adapter.ts'
import {
  addEntry,
  CC_EVENT,
  type HookEvent,
  listEntries,
  MATCHER_EVENTS,
  openStore,
  removeEntry,
  writeStore,
  type HookEntry,
} from './store.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-hooks'

/** Capability service required to register the model-facing tools. */
export const inject = ['tools']

/** Hard ceiling for one hook's kill timeout, in seconds (the dialect default). */
export const MAX_TIMEOUT_SECONDS = 600

/** Default cap on total hook groups kept in one workspace file. */
export const DEFAULT_MAX_HOOKS = 256

/** Deployment-owned bound on how many hooks one workspace file may carry. */
export interface Config {
  /** Maximum total hook groups (managed plus foreign) kept in the file. Defaults to 256. */
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

const EVENT_VALUES = Object.keys(CC_EVENT) as HookEvent[]

const ADD_PARAMETERS = {
  name: {
    type: 'string',
    required: true,
    description: 'Stable identifier for this hook, unique in the workspace. hook_list shows it; hook_remove uses it.',
  },
  event: {
    type: 'string',
    enum: EVENT_VALUES,
    required: true,
    description: 'When the command runs: pre_tool and post_tool surround each tool call; prompt_submit fires on every '
      + 'submitted user prompt; session_start runs once when the session opens; stop runs when the agent finishes a turn; '
      + 'subagent_start and subagent_stop run when a subagent opens or closes.',
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
} as const

const LIST_PARAMETERS = {}

/** The model-facing view of one listed hook (no file paths, no dialect names). */
type HookView = {
  name: string
  event: HookEvent
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

/** The session workspace every hook operates on; agent-backed sessions always have one. */
function requireCwd(exec: ToolExecution): string {
  if (exec.agent === undefined) throw new Error('hook tools require an agent-backed session')
  const cwd = exec.agent.session.header.cwd
  if (cwd === undefined || cwd.length === 0) throw new Error('the session has no workspace directory, so hooks cannot be managed')
  return cwd
}

/** Validate one add call against the store rules before anything is written. */
function validateAdd(input: {
  name: string
  event: HookEvent
  matcher?: string
  timeoutSeconds?: number
}, entries: readonly HookEntry[]): void {
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
  if (entries.some(entry => entry.name === input.name)) {
    throw new Error(`a hook named "${input.name}" already exists; remove it first with hook_remove`)
  }
}

/** Register the workspace hook tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'hook_add',
    description: 'Install a workspace hook: a shell command that runs automatically at a lifecycle point and can gate, '
      + 'enrich, or observe the agent — for example, ask the user before every bash call, or log each web fetch. Takes '
      + 'effect from the next matching event; every run is recorded in the session log. List with hook_list, remove with '
      + 'hook_remove.',
    parameters: ADD_PARAMETERS,
    output: JSON_OUTPUT,
    execute: (args, exec) => Promise.resolve().then(() => {
      const store = openStore(requireCwd(exec))
      const entries = listEntries(store)
      const entry = {
        name: args.name,
        event: args.event,
        ...args.matcher !== undefined ? { matcher: args.matcher } : {},
        command: args.command,
        ...args.timeout_seconds !== undefined ? { timeoutSeconds: args.timeout_seconds } : {},
      }
      validateAdd(entry, entries)
      if (entries.length >= resolved.maxHooks) {
        throw new Error(`the workspace already carries ${entries.length} hooks (limit ${resolved.maxHooks}); remove some first`)
      }
      installAdapter(store.adapterPath)
      addEntry(store, entry, bridgeCommand(store.adapterPath, store.configPath, entry.name))
      writeStore(store)
      return {
        added: viewOf({ ...entry, managed: true }),
        effect: 'runs from the next matching event; an in-flight invocation is unaffected',
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'hook_remove',
    description: 'Remove one workspace hook by the name hook_list shows. Takes effect from the next matching event; an '
      + 'already-running invocation is unaffected.',
    parameters: REMOVE_PARAMETERS,
    output: JSON_OUTPUT,
    execute: (args, exec) => Promise.resolve().then(() => {
      const store = openStore(requireCwd(exec))
      const removed = removeEntry(store, args.name)
      if (removed === undefined) throw new Error(`no hook named "${args.name}"; call hook_list for the current names`)
      writeStore(store)
      return { removed: viewOf(removed) }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'hook_list',
    description: "List this workspace's hooks: name, event, matcher, command, and timeout. Names shaped like "
      + "'pre_tool#1' are hand-written entries the tools did not install; remove and reinstall them to manage them through the tools.",
    parameters: LIST_PARAMETERS,
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (_args, exec) => Promise.resolve().then(() => {
      const store = openStore(requireCwd(exec))
      return { hooks: listEntries(store).map(viewOf) }
    }),
  }))
}
