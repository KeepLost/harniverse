/**
 * Persistence for model-managed hooks over the Claude-Code-dialect project-layer
 * hook file. The model-facing surface never exposes the file: this module owns
 * the dialect shape (event names, matcher groups, one command hook per managed
 * entry, an embedded stable name) and preserves any foreign keys it did not write.
 *
 * @module @deepseek-ai/dsh-tool-hooks/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Directory components of the project-layer hook file, relative to the session workspace. */
export const HOOKS_DIR_PARTS = ['.dsh', 'hooks'] as const

/** The Claude-Code-dialect project-layer filename the bridge discovers per event. */
export const HOOKS_FILENAME = 'claude-code.json'

/** The generated adapter script the bridge-visible command invokes. */
export const ADAPTER_FILENAME = 'tool-hooks-adapter.mjs'

/** Model-facing event identifiers, in disclosure order. */
export type HookEvent =
  | 'pre_tool'
  | 'post_tool'
  | 'prompt_submit'
  | 'session_start'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

/** Every model-facing event and its Claude-Code dialect event name. */
export const CC_EVENT: Readonly<Record<HookEvent, string>> = {
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  prompt_submit: 'UserPromptSubmit',
  session_start: 'SessionStart',
  stop: 'Stop',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
}

/** Dialect event name back to the model-facing identifier. */
export const MODEL_EVENT: Readonly<Record<string, HookEvent>> = Object.fromEntries(
  Object.entries(CC_EVENT).map(([model, cc]) => [cc, model as HookEvent]),
)

/** Events whose dialect group carries a matcher (the others discard it). */
export const MATCHER_EVENTS: readonly HookEvent[] = ['pre_tool', 'post_tool', 'session_start', 'subagent_start', 'subagent_stop']

/** One managed hook as the model sees it. */
export interface HookEntry {
  readonly name: string
  readonly event: HookEvent
  readonly matcher?: string
  readonly command: string
  readonly timeoutSeconds?: number
  /** False for foreign hand-written entries, which list under a derived positional name. */
  readonly managed: boolean
}

/** A parsed hook file plus the absolute paths the tool operates on. */
export interface HookStore {
  /** Absolute path of the dialect hook file. */
  readonly configPath: string
  /** Absolute path of the generated adapter script beside it. */
  readonly adapterPath: string
  /** Parsed JSON root (never an array or primitive). */
  root: Record<string, unknown>
  /** True when the root itself is the event map; false when it nests under `hooks`. */
  bare: boolean
}

/** The mutable event map a root carries; `openStore` guarantees the shape behind `bare`. */
function eventMap(store: HookStore): Record<string, unknown> {
  return store.bare ? store.root : store.root.hooks as Record<string, unknown>
}

/** Read the hook file for one session workspace; a missing file reads as empty.
 * @param cwd - the session workspace directory holding the `.dsh/hooks` tree.
 * @returns the parsed store plus the absolute paths the tool operates on.
 */
export function openStore(cwd: string): HookStore {
  const configPath = resolve(cwd, ...HOOKS_DIR_PARTS, HOOKS_FILENAME)
  const adapterPath = resolve(cwd, ...HOOKS_DIR_PARTS, ADAPTER_FILENAME)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`the existing hooks file is not valid JSON (${configPath}): ${String(error)}`)
    }
    return { configPath, adapterPath, root: {}, bare: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`the existing hooks file is not a JSON object (${configPath})`)
  }
  const root = raw as Record<string, unknown>
  const bare = typeof root.hooks !== 'object' || root.hooks === null || Array.isArray(root.hooks)
  return { configPath, adapterPath, root, bare }
}

/** List every hook group in the file: managed entries by name, foreign entries by positional id.
 * @param store - the opened hook file.
 * @returns every usable group in disclosure order.
 */
export function listEntries(store: HookStore): HookEntry[] {
  const map = eventMap(store)
  const entries: HookEntry[] = []
  for (const [modelEvent, ccEvent] of Object.entries(CC_EVENT) as [HookEvent, string][]) {
    const candidate: unknown = map[ccEvent]
    if (!Array.isArray(candidate)) continue
    const groups: unknown[] = candidate
    let ordinal = 0
    for (const group of groups) {
      ordinal += 1
      const entry = entryOf(modelEvent, group, ordinal)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

/** Build one list entry from a raw dialect group, or undefined for an unusable shape. */
function entryOf(event: HookEvent, group: unknown, ordinal: number): HookEntry | undefined {
  if (typeof group !== 'object' || group === null || Array.isArray(group)) return undefined
  const record = group as Record<string, unknown>
  if (isDisabled(record)) return undefined
  const hooks = record.hooks
  if (!Array.isArray(hooks)) return undefined
  const commands = hooks
    .filter((hook): hook is Record<string, unknown> => typeof hook === 'object' && hook !== null && !Array.isArray(hook))
    .filter(hook => typeof hook.command === 'string' && !isDisabled(hook))
  if (commands.length === 0) return undefined
  const single = commands.length === 1 ? commands[0] : undefined
  const run = single !== undefined && typeof single.run === 'string' ? single.run : undefined
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
  const managed = name !== undefined && run !== undefined && single !== undefined
  const timeout = typeof single?.timeout === 'number' ? single.timeout : undefined
  const matcherSubject = MATCHER_EVENTS.includes(event)
  const matcher = matcherSubject && typeof record.matcher === 'string' ? record.matcher : undefined
  return {
    name: managed ? name : `${event}#${ordinal}`,
    event,
    ...matcher !== undefined ? { matcher } : {},
    command: managed ? run : commands.map(hook => hook.command as string).join(' ; '),
    ...timeout !== undefined ? { timeoutSeconds: timeout } : {},
    managed,
  }
}

/** Append one managed group to the store; rejects duplicate names outright.
 * @param store - the opened hook file to mutate.
 * @param entry - the managed hook to append.
 * @param bridgeCommand - the adapter-routed command the bridge will execute.
 */
export function addEntry(store: HookStore, entry: Omit<HookEntry, 'managed'>, bridgeCommand: string): void {
  const map = eventMap(store)
  const existing = listEntries(store)
  if (existing.some(candidate => candidate.name === entry.name)) {
    throw new Error(`a hook named "${entry.name}" already exists; remove it first with hook_remove`)
  }
  const ccEvent = CC_EVENT[entry.event]
  const groups = Array.isArray(map[ccEvent]) ? map[ccEvent] as unknown[] : []
  const hook: Record<string, unknown> = {
    type: 'command',
    command: bridgeCommand,
    run: entry.command,
    ...entry.timeoutSeconds !== undefined ? { timeout: entry.timeoutSeconds } : {},
  }
  const group: Record<string, unknown> = {
    name: entry.name,
    ...entry.matcher !== undefined ? { matcher: entry.matcher } : {},
    hooks: [hook],
  }
  groups.push(group)
  map[ccEvent] = groups
}

/** Remove one group by its listed name (managed name or positional id); returns the removed entry or undefined.
 * @param store - the opened hook file to mutate.
 * @param name - the listed name identifying the group.
 * @returns the removed entry, or undefined when no listed hook carries the name.
 */
export function removeEntry(store: HookStore, name: string): HookEntry | undefined {
  const map = eventMap(store)
  for (const [modelEvent, ccEvent] of Object.entries(CC_EVENT) as [HookEvent, string][]) {
    const candidate: unknown = map[ccEvent]
    if (!Array.isArray(candidate)) continue
    const groups: unknown[] = candidate
    let ordinal = 0
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]
      ordinal += 1
      const entry = entryOf(modelEvent, group, ordinal)
      if (entry !== undefined && entry.name === name) {
        groups.splice(index, 1)
        if (groups.length === 0) Reflect.deleteProperty(map, ccEvent)
        return entry
      }
    }
  }
  return undefined
}

/** Atomically write the store back to disk, creating the directory when absent.
 * @param store - the mutated store to persist.
 */
export function writeStore(store: HookStore): void {
  const text = `${JSON.stringify(store.root, null, 2)}\n`
  mkdirSync(dirname(store.configPath), { recursive: true })
  const temporary = `${store.configPath}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, store.configPath)
}

/** The dialect's disable markers, honored on groups and individual hooks alike. */
function isDisabled(record: Record<string, unknown>): boolean {
  return record.disabled === true || record.enabled === false
}

/** A Node ENOENT-shaped miss. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
