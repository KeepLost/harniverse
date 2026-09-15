/**
 * Model-facing session-history search and read tools with id-bound observations.
 *
 * @module @deepseek-ai/dsh-tool-session-query
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { toolInput } from './input.ts'
import { operations } from './operations.ts'
import { presentation } from './presentation.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-session-query'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery']

/** Default maximum number of authorized discovery/search hits returned by one call. */
export const DEFAULT_MAX_SEARCH_RESULTS = 100

/** Default cooperative deadline for indexed discovery or full-text search. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
/** Default finalized-message count returned by the `session_inspect` messages view. */
export const DEFAULT_MESSAGE_TAIL_LIMIT = 10
/** Hard model-facing finalized-message limit for one inspection. */
export const MAX_MESSAGE_TAIL_LIMIT = 50
/** Default complete raw-event count returned by the `session_inspect` history view. */
export const DEFAULT_LOG_TAIL_LIMIT = 20
/** Hard model-facing complete raw-event limit for one inspection. */
export const MAX_LOG_TAIL_LIMIT = 50

/** Deployment-owned discovery/search count, timeout, and tail bounds. */
export interface Config {
  /** Maximum authorized hits returned by one discovery/search call. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative indexed discovery/search deadline in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
  /** Default number of finalized messages returned by the session_inspect messages view. */
  messageTailLimit?: number
  /** Default number of complete raw events returned by the session_inspect history view. */
  logTailLimit?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SEARCH_TIMEOUT_MS),
  messageTailLimit: z.number().step(1).min(1).max(MAX_MESSAGE_TAIL_LIMIT).default(DEFAULT_MESSAGE_TAIL_LIMIT),
  logTailLimit: z.number().step(1).min(1).max(MAX_LOG_TAIL_LIMIT).default(DEFAULT_LOG_TAIL_LIMIT),
})

interface ResolvedConfig {
  readonly maxSearchResults: number
  readonly searchTimeoutMs: number
  readonly messageTailLimit: number
  readonly logTailLimit: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT =
  'Session research: find prior sessions by title, creation time, or activity window with session_find, which returns session metadata only. '
  + 'Find sessions by content wording with session_search, which returns each session\'s strongest matching event with seq and snippet; any language matches, including sub-word CJK terms, and compacted turns remain searchable. '
  + 'Pass exactly one session_id to session_search to list every matching event in that one session instead; the current session is an allowed target and stops before the active step. '
  + 'Read one session with session_inspect: summary status; messages (the current folded view — compacted turns are absent); history (complete raw events, compacted originals included); one event; or lineage. '
  + 'The current session\'s compacted summaries are recovered with compaction_history_search then compaction_history_expand. '
  + 'Use session_message to continue a known ordinary session or direct subagent session; inbox acceptance does not mean completion. Search and find results are cursor-free.'

/** Register discovery, search, and unified inspection tools with shared guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:session-query',
    order: 113,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_find',
    description: 'Find prior sessions by current title, creation time, or raw-event activity time. Returns session metadata only — no matched content or snippets. Start here when you know when a session happened or what it is titled, not the words inside it.',
    parameters: toolInput.sessionFindParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeSessionFind(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentation.presentSessionFindCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_search',
    description: 'Search session content and return each session\'s strongest matching event with seq and snippet. Pass exactly one session_id to return every matching event in that session instead, including the current session up to the previous step. Compacted turns stay searchable; CJK sub-words match.',
    parameters: toolInput.sessionSearchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeSessionSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentation.presentSessionSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_inspect',
    description: 'Read one authorized session through a unified view: summary status, folded messages, raw history, one event, or lineage. Compacted turns are absent from the messages view — read history or lineage for them. Never resumes a cold session.',
    parameters: toolInput.sessionInspectParameters,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeSessionInspect(
      ctx,
      args,
      exec,
      resolved.messageTailLimit,
      resolved.logTailLimit,
      MAX_LOG_TAIL_LIMIT,
    ),
    presentCall: args => presentation.presentSessionTargetCall(`Inspect ${args.view}`, args),
  }))

}

function resolveConfig(config: Config): ResolvedConfig {
  const maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const searchTimeoutMs = config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new TypeError('tool-session-query: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `tool-session-query: searchTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const messageTailLimit = config.messageTailLimit ?? DEFAULT_MESSAGE_TAIL_LIMIT
  if (!Number.isSafeInteger(messageTailLimit) || messageTailLimit < 1 || messageTailLimit > MAX_MESSAGE_TAIL_LIMIT) {
    throw new TypeError(`tool-session-query: messageTailLimit must be between 1 and ${MAX_MESSAGE_TAIL_LIMIT}`)
  }
  const logTailLimit = config.logTailLimit ?? DEFAULT_LOG_TAIL_LIMIT
  if (!Number.isSafeInteger(logTailLimit) || logTailLimit < 1 || logTailLimit > MAX_LOG_TAIL_LIMIT) {
    throw new TypeError(`tool-session-query: logTailLimit must be between 1 and ${MAX_LOG_TAIL_LIMIT}`)
  }
  return { maxSearchResults, searchTimeoutMs, messageTailLimit, logTailLimit }
}
