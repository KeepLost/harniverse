/**
 * One-shot MCP server probe: connect, read the server identity, list tool
 * names, close. Nothing registers on `ctx.tools`, no namespace is reserved,
 * and nothing persists — the probe answers a configuration surface's "test
 * this server" without touching the live fleet. Expected failures return a
 * stage-classified value rather than throwing, so a wire caller renders the
 * outcome without exception mapping; closing the probe's client is settled
 * independently of the stage outcome.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createTransport } from './transport.ts'
import type { Config } from './config.ts'

/** Options for one {@link probeServer} call. */
export interface McpProbeOptions {
  /** Budget for the whole probe (connect + listing) in milliseconds; default 10000. */
  readonly timeoutMs?: number
  /** Maximum listing pages before returning a truncated result; default 16. */
  readonly maxPages?: number
  /** Maximum raw tool names retained in the result; default 512. */
  readonly maxToolNames?: number
  /**
   * Abort the in-flight probe; settles as a failure at the current stage after
   * bounded closure.
   */
  readonly signal?: AbortSignal
}

/** Stage a probe failure is classified under. */
export type McpProbeStage = 'connect' | 'list'

/** Server identity a probe read before listing. */
export interface McpProbeServerInfo {
  readonly name: string
  readonly version: string
}

/** A probe that reached the end of its listing. */
export interface McpProbeSuccess {
  readonly ok: true
  /** The server's reported identity; absent when the wire omitted it. */
  readonly serverInfo?: McpProbeServerInfo
  /** Raw tool names in server order, capped to {@link McpProbeOptions.maxToolNames}. */
  readonly toolNames: readonly string[]
  /** True when caps ended the listing early. */
  readonly truncated: boolean
  readonly durationMs: number
}

/** A probe that failed at a classified stage; the message renders on management surfaces. */
export interface McpProbeFailure {
  readonly ok: false
  readonly stage: McpProbeStage
  readonly message: string
  readonly durationMs: number
}

/** Outcome of closing the probe's client after the stage settled. */
export interface McpProbeCleanup {
  readonly cleanup: 'ok' | 'failed'
  /** Diagnostic for a failed closure; absent on success. */
  readonly cleanupError?: string
}

/** Stage-classified probe outcome with independently settled cleanup. */
export type McpProbeResult = (McpProbeSuccess | McpProbeFailure) & McpProbeCleanup

/** Default whole-probe budget (ms): interactive surfaces need a bounded answer. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** Listing page cap: a cursor loop or firehose server ends as truncation, not a hang. */
const PROBE_MAX_PAGES = 16

/** Tool-name cap on the returned list. */
const PROBE_MAX_TOOL_NAMES = 512

/** Closure grace: the SDK's stdio transport owns two two-second termination periods. */
const PROBE_CLOSE_GRACE_MS = 5_000

function resolveProbeOptions(options: McpProbeOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const maxPages = options.maxPages ?? PROBE_MAX_PAGES
  const maxToolNames = options.maxToolNames ?? PROBE_MAX_TOOL_NAMES
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('probeServer: timeoutMs must be a positive finite number')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('probeServer: maxPages must be a positive safe integer')
  if (!Number.isSafeInteger(maxToolNames) || maxToolNames < 1) throw new TypeError('probeServer: maxToolNames must be a positive safe integer')
  return { timeoutMs, maxPages, maxToolNames, signal: options.signal }
}

/** One probe message rendered without stack traces or transport internals. */
/* v8 ignore next 4 -- the SDK rejects with non-empty Error instances; the fallbacks keep the message total for programmatic callers. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** Reject when the budget runs out before the operation settles. */
function withBudget<T>(operation: Promise<T>, remainingMs: number, stage: McpProbeStage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      /* v8 ignore next 2 -- the settle path clears the timer first; the guard only covers a same-tick race. */
      if (settled) return
      settled = true
      reject(new Error(`${stage === 'connect' ? 'connect' : 'list'} timed out after ${remainingMs}ms`))
    }, Math.max(0, remainingMs))
    timer.unref()
    operation.then((value: T) => {
      /* v8 ignore next 2 -- the settle path clears the timer first; the guard only covers a same-tick race. */
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      /* v8 ignore next -- the SDK rejects with Error instances; the wrap keeps non-Error rejections out of the message field. */
      reject(error instanceof Error ? error : new Error(messageOf(error)))
    })
  })
}

/**
 * Probe a server without registering tools or reserving its namespace.
 * @param config - transport configuration; its startup budget does not bound the probe.
 * @param options - whole-probe budget, listing caps, and cancellation signal.
 * @returns the connect/list outcome and independent cleanup result after bounded closure.
 * @throws for invalid options.
 */
export async function probeServer(config: Config, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const spec = resolveProbeOptions(options)
  const startedAt = Date.now()
  const remaining = (): number => spec.timeoutMs - (Date.now() - startedAt)
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' }, { capabilities: {} })

  let closing: Promise<McpProbeCleanup> | undefined
  const closeProbe = (): Promise<McpProbeCleanup> => {
    closing ??= (async () => {
      try {
        /* v8 ignore next 6 -- the race only guards a wedged transport from hanging a probe past the SDK's close grace. */
        await Promise.race([
          client.close(),
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error('probe close timed out')) }, PROBE_CLOSE_GRACE_MS)
            timer.unref()
          }),
        ])
        return { cleanup: 'ok' as const }
      } catch (error: unknown) {
        return { cleanup: 'failed' as const, cleanupError: messageOf(error) }
      }
    })()
    return closing
  }

  const abort = (): void => { void closeProbe() }
  spec.signal?.addEventListener('abort', abort, { once: true })
  if (spec.signal?.aborted) abort()

  let stage: McpProbeStage = 'connect'
  let result: McpProbeSuccess | McpProbeFailure
  try {
    // A signal aborted before the probe starts never touches the wire.
    if (spec.signal?.aborted) throw new Error('probe aborted')
    await withBudget(client.connect(createTransport(config)), remaining(), 'connect')
    /* v8 ignore next -- MCP requires serverInfo on initialize; the guard
       only keeps the field optional for peers that omit it. */
    const identity = client.getServerVersion()
    stage = 'list'
    const toolNames: string[] = []
    let truncated = false
    let cursor: string | undefined
    if (client.getServerCapabilities()?.tools !== undefined) {
      for (let page = 0; page < spec.maxPages; page++) {
        const response = await withBudget(client.request(
          { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
          ListToolsResultSchema,
        ), remaining(), 'list')
        for (const tool of response.tools) {
          if (toolNames.length >= spec.maxToolNames) { truncated = true; break }
          toolNames.push(tool.name)
        }
        cursor = response.nextCursor
        if (cursor === undefined || truncated) break
        if (page === spec.maxPages - 1) truncated = true
      }
    }
    const durationMs = Date.now() - startedAt
    result = {
      ok: true,
      /* v8 ignore next 1 -- MCP requires serverInfo on initialize; the arm only keeps the field optional. */
      ...identity === undefined ? {} : { serverInfo: { name: identity.name, version: identity.version } },
      toolNames,
      truncated,
      durationMs,
    }
  } catch (error: unknown) {
    result = {
      ok: false,
      stage,
      message: spec.signal?.aborted ? 'probe aborted' : messageOf(error),
      durationMs: Date.now() - startedAt,
    }
  } finally {
    spec.signal?.removeEventListener('abort', abort)
  }
  return { ...result, ...await closeProbe() }
}
