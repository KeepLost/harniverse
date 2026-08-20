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
/** Default finalized-message count returned by `session_message_tail`. */
export const DEFAULT_MESSAGE_TAIL_LIMIT = 10
/** Hard model-facing finalized-message limit for one tail read. */
export const MAX_MESSAGE_TAIL_LIMIT = 50
/** Default complete raw-event count returned by `session_log_tail`. */
export const DEFAULT_LOG_TAIL_LIMIT = 20
/** Hard model-facing complete raw-event limit for one tail read. */
export const MAX_LOG_TAIL_LIMIT = 50

/** Deployment-owned discovery/search count, timeout, and tail bounds. */
export interface Config {
  /** Maximum authorized hits returned by one discovery/search call. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative indexed discovery/search deadline in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
  /** Default number of finalized messages returned by session_message_tail. */
  messageTailLimit?: number
  /** Default number of complete raw events returned by session_log_tail. */
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
  'Use session_find to locate prior sessions by current title, creation time, or raw-event activity time; session_find returns session metadata without content-match events or snippets. '
  + 'Use session_search to search prior-session content; session_search returns matching event seqs and snippets. Use session_event_search for content inside one session. '
  + 'After discovery, session_log_tail reads complete raw events from the recent log; after a content hit, session_event_read reads a complete raw-event window around its seq. '
  + 'session_message_tail reads only the folded current model-message surface, not historical raw-log trajectory. Search and find results are cursor-free.'

/** Register all nine tools and their shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:session-query',
    order: 113,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_find',
    description: 'Find prior sessions by current title, creation time, or raw-event activity time. Returns session metadata, never content-match events or snippets.',
    parameters: toolInput.sessionFindParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeSessionFind(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentation.presentSessionFindCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_search',
    description: 'Search prior sessions and return the strongest matching event from each session; optionally filter by cwd.',
    parameters: toolInput.sessionSearchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeSessionSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentation.presentSessionSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_search',
    description: 'Search prior events in one authorized session; the current session excludes the step performing this call.',
    parameters: toolInput.eventSearchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeEventSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentation.presentEventSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_status',
    description: 'Read whether an authorized session is live and whether its Agent is running without resuming a cold session.',
    parameters: toolInput.targetSessionParameter,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeSessionStatus(ctx, args, exec),
    presentCall: args => presentation.presentSessionTargetCall('Read status for', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_message_tail',
    description: 'Read the folded current model-message surface tail from an authorized session. This is not historical raw-log trajectory.',
    parameters: toolInput.messageTailParameters,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeMessageTail(ctx, args, exec, resolved.messageTailLimit, MAX_MESSAGE_TAIL_LIMIT),
    presentCall: args => presentation.presentSessionTargetCall('Read message tail from', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_log_tail',
    description: 'Read the latest complete raw SessionEvent trajectory from an authorized session, including shadowed and log-only events.',
    parameters: toolInput.logTailParameters,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeLogTail(ctx, args, exec, resolved.logTailLimit, MAX_LOG_TAIL_LIMIT),
    presentCall: args => presentation.presentSessionTargetCall('Read raw log tail from', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_trace',
    description: 'Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.',
    parameters: toolInput.targetSessionParameter,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeSessionTrace(ctx, args, exec),
    presentCall: args => presentation.presentSessionTargetCall('Trace', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_trace',
    description: 'Read every direct replacement and relationship to a cited source event for one event in an authorized session.',
    parameters: {
      ...toolInput.targetSessionParameter,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeEventTrace(ctx, args, exec),
    presentCall: args => presentation.presentEventTargetCall('Trace event', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_read',
    description: 'Read a complete raw SessionEvent window around one event sequence from an authorized session.',
    parameters: {
      ...toolInput.targetSessionParameter,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
      before: { type: 'integer', description: 'Number of preceding complete raw events to include. Omit for none.' },
      after: { type: 'integer', description: 'Number of following complete raw events to include. Omit for none.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeEventRead(ctx, args, exec),
    presentCall: args => presentation.presentEventTargetCall('Read event', args),
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
