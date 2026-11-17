/**
 * The session-held hook layer: hooks whose durable home is the session log
 * itself. A `hook/config` event carries the complete managed set as one
 * snapshot (last event wins, `todo/write` precedent), so the fold survives
 * restart by replay and compaction without external state. Bridges fold the
 * session layer FIRST — the specificity order `session → user → project →
 * plugin → policy` — ahead of every discovered file source, while
 * permission outcomes stay order-independent (deny > ask > allow, see
 * `merge.ts`).
 *
 * Session-layer commands run through the same generated adapter as file-held
 * managed hooks, installed once under the harness home; the adapter reads
 * session entries' real command inline from its argv. `@deepseek-ai/dsh-tool-hooks`
 * owns the adapter script and installs it; a missing adapter file fails the
 * hook run itself, which the `hook/result` record captures.
 *
 * @module @deepseek-ai/dsh-hook-protocol/session-layer
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MatcherGroup } from './types.ts'

/** Model-facing hook event identifiers, in disclosure order. */
export type PortableHookEvent =
  | 'pre_tool'
  | 'post_tool'
  | 'prompt_submit'
  | 'session_start'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

/** Every portable event and its Claude-Code dialect point. */
export const PORTABLE_TO_CLAUDE_CODE: Readonly<Record<PortableHookEvent, string>> = {
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  prompt_submit: 'UserPromptSubmit',
  session_start: 'SessionStart',
  stop: 'Stop',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
}

/** Events whose point carries a match subject (the others discard matchers). */
export const MATCHER_EVENTS: readonly PortableHookEvent[] = ['pre_tool', 'post_tool', 'session_start', 'subagent_start', 'subagent_stop']

/** One managed session hook exactly as the model faces it. */
export interface SessionHookSpec {
  /** Stable identifier, unique within the session set. */
  readonly name: string
  /** The lifecycle point the command runs at. */
  readonly event: PortableHookEvent
  /** Unanchored regex tested against the point's match subject, when set. */
  readonly matcher?: string
  /** The real shell command. */
  readonly command: string
  /** Per-hook kill timeout in seconds, when set. */
  readonly timeoutSec?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's complete managed hook set — log-only (like `hook/invoked`;
     * NOT a {@link SurfaceEventType}, carries no `surfaceOp`): the LAST such
     * event is the session's effective set, so folds survive replay and
     * compaction with no external store. `source: 'delegation'` marks a set
     * seeded from the delegating parent at subagent start; it is only legal as
     * the session's first `hook/config` event.
     */
    'hook/config': {
      hooks: SessionHookSpec[]
      /** Marks a seed inherited from the delegating parent. */
      source?: 'delegation'
    }
  }
}

/** Fold a session's effective managed hook set from its durable event log.
 * @param events - the session's committed events, oldest first.
 * @returns the last `hook/config` snapshot's hooks (freshly rearrayed), or an empty set before any install.
 */
export function foldSessionHooks(events: readonly SessionEvent[]): readonly SessionHookSpec[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'hook/config') return [...event.data.hooks]
  }
  return []
}

/** The generated adapter's filename under the harness home hooks directory. */
export const HOME_ADAPTER_FILENAME = 'tool-hooks-adapter.mjs'

/** Resolve the shared adapter's absolute path under the harness home.
 * @returns the adapter path every managed hook invocation routes through.
 */
export function homeHookAdapterPath(): string {
  return dshHomePath('hooks', HOME_ADAPTER_FILENAME)
}

/** Double-quote one command argument for POSIX shells and Windows cmd/pwsh alike. */
export function quoteHookCommandArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** The bridge-visible command for one session-held hook: adapter plus inline real command.
 * @param adapterPath - absolute path of the generated adapter script.
 * @param run - the real shell command the adapter pipes the event payload to.
 * @returns the shell command a bridge executes.
 */
export function inlineAdapterCommand(adapterPath: string, run: string): string {
  return `node ${quoteHookCommandArgument(adapterPath)} --run ${quoteHookCommandArgument(run)}`
}

/** Project one folded session hook set onto Claude-Code matcher groups.
 * @param specs - the session's folded managed hooks, in install order.
 * @param adapterPath - absolute path of the generated adapter script.
 * @returns per Claude-Code point, the matcher groups to run before every file source.
 */
export function claudeCodeSessionGroups(
  specs: readonly SessionHookSpec[],
  adapterPath: string,
): Readonly<Record<string, readonly MatcherGroup[]>> {
  const groups: Record<string, MatcherGroup[]> = {}
  for (const spec of specs) {
    const point = PORTABLE_TO_CLAUDE_CODE[spec.event]
    groups[point] = [...groups[point] ?? [], {
      ...MATCHER_EVENTS.includes(spec.event) && spec.matcher !== undefined ? { matcher: spec.matcher } : {},
      hooks: [{
        command: inlineAdapterCommand(adapterPath, spec.command),
        ...spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {},
      }],
    }]
  }
  return groups
}
