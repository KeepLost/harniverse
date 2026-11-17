/**
 * Persistence for model-managed hooks over the Claude-Code-dialect hook files.
 * The model-facing surface never exposes the files: this module owns the
 * dialect shape (event names, matcher groups, one command hook per managed
 * entry, an embedded stable name) and preserves any foreign keys it did not
 * write. One store serves one file target — the workspace layer's project file
 * or the global layer's home file; the session layer lives in the session log
 * (see `@deepseek-ai/dsh-hook-protocol/session-layer`).
 *
 * @module @deepseek-ai/dsh-tool-hooks/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PORTABLE_TO_CLAUDE_CODE as CC_EVENT, SESSION_MATCHER_EVENTS as MATCHER_EVENTS, type PortableHookEvent } from '@deepseek-ai/dsh-hook-protocol'

export { PORTABLE_TO_CLAUDE_CODE as CC_EVENT, SESSION_MATCHER_EVENTS as MATCHER_EVENTS } from '@deepseek-ai/dsh-hook-protocol'
export type { PortableHookEvent as HookEvent } from '@deepseek-ai/dsh-hook-protocol'

/** Directory components of the workspace-layer hook file, relative to the session workspace. */
export const HOOKS_DIR_PARTS = ['.dsh', 'hooks'] as const

/** The Claude-Code-dialect filename the bridge discovers per event. */
export const HOOKS_FILENAME = 'claude-code.json'

/** One managed hook as the model sees it. */
export interface HookEntry {
  readonly name: string
  readonly event: PortableHookEvent
  readonly matcher?: string
  readonly command: string
  readonly timeoutSeconds?: number
  /** False for foreign hand-written entries, which list under a derived positional name. */
  readonly managed: boolean
}

/** A parsed hook file plus the absolute path the tool operates on. */
export interface HookStore {
  /** Absolute path of the dialect hook file. */
  readonly configPath: string
  /** Parsed JSON root (never an array or primitive). */
  root: Record<string, unknown>
  /** True when the root itself is the event map; false when it nests under `hooks`. */
  bare: boolean
}

/** The mutable event map a root carries; `openStore` guarantees the shape behind `bare`. */
function eventMap(store: HookStore): Record<string, unknown> {
  return store.bare ? store.root : store.root.hooks as Record<string, unknown>
}

/** Read one hook file target; a missing file reads as empty.
 * @param configDir - the directory holding the dialect hook file.
 * @returns the parsed store plus the absolute path the tool operates on.
 */
export function openStore(configDir: string): HookStore {
  const configPath = resolve(configDir, HOOKS_FILENAME)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`the existing hooks file is not valid JSON (${configPath}): ${String(error)}`)
    }
    return { configPath, root: {}, bare: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`the existing hooks file is not a JSON object (${configPath})`)
  }
  const root = raw as Record<string, unknown>
  const bare = typeof root.hooks !== 'object' || root.hooks === null || Array.isArray(root.hooks)
  return { configPath, root, bare }
}

/** The workspace-layer hook directory inside one session workspace.
 * @param cwd - the session workspace directory.
 * @returns the directory holding the project-layer dialect hook file.
 */
export function workspaceHooksDir(cwd: string): string {
  return resolve(cwd, ...HOOKS_DIR_PARTS)
}

/** List every hook group in the file: managed entries by name, foreign entries by positional id.
 * @param store - the opened hook file.
 * @returns every usable group in disclosure order.
 */
export function listEntries(store: HookStore): HookEntry[] {
  const map = eventMap(store)
  const entries: HookEntry[] = []
  for (const [modelEvent, ccEvent] of Object.entries(CC_EVENT) as [PortableHookEvent, string][]) {
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
function entryOf(event: PortableHookEvent, group: unknown, ordinal: number): HookEntry | undefined {
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
  for (const [modelEvent, ccEvent] of Object.entries(CC_EVENT) as [PortableHookEvent, string][]) {
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
