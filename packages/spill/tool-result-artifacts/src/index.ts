/**
 * Finalized tool-result retention and model-facing paged artifact retrieval.
 * @module @deepseek-ai/dsh-tool-result-artifacts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  GenericCallView,
  ToolExecution,
  ToolExecutionFailure,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { ToolResultArtifact } from '@deepseek-ai/dsh-session'

const DEFAULT_PAGE_CHARS = 12_000
const MAX_PAGE_CHARS = 50_000
const MAX_CURSOR_CHARS = 90
const CONTINUATION_PREFIX = '\n\nartifact_read cursor="'
const CONTINUATION_SUFFIX = '"'
const CONTINUATION_RESERVE = Array.from(CONTINUATION_PREFIX).length
  + MAX_CURSOR_CHARS
  + Array.from(CONTINUATION_SUFFIX).length
const RETENTION_FAILURE_WARNING = 'Complete tool result was not retained. The operation may have completed. Do not retry blindly; it may have side effects.'

/** Smallest result-text limit that can carry the mandatory safety warning. */
export const MIN_RESULT_TEXT_CHARS = Array.from(RETENTION_FAILURE_WARNING).length

/** Stable failure code when an oversized complete result cannot be retained. */
export const TOOL_RESULT_RETENTION_FAILED = 'TOOL_RESULT_RETENTION_FAILED'

const MAX_RESULT_TEXT_CHARS = 50_000

/** Cordis function-plugin name. */
export const name = 'tool-result-artifacts'

/** Services required for result retention and `artifact_read`. */
export const inject = ['tools', 'spillStore']

/** Deployment-selected retention and artifact paging limits. */
export interface Config {
  /** Maximum Unicode code points across finalized model-visible result text. */
  maxResultTextChars?: number
  /** Maximum Unicode code points requested from the backend per call. */
  pageChars?: number
}

/** Loader config schema for result retention and artifact paging. */
export const Config: z<Config> = z.object({
  maxResultTextChars: z.natural().min(MIN_RESULT_TEXT_CHARS).max(MAX_RESULT_TEXT_CHARS).default(MAX_RESULT_TEXT_CHARS),
  pageChars: z.number().step(1).min(1).max(MAX_PAGE_CHARS).default(DEFAULT_PAGE_CHARS),
})

interface ResolvedConfig {
  readonly pageChars: number
  readonly maxResultTextChars: number
}

interface ArtifactPage {
  text: string
  nextCursor?: string
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    nextCursor: { type: 'string' },
  },
} as const

function resolveConfig(config: Config): ResolvedConfig {
  const maxResultTextChars = config.maxResultTextChars ?? MAX_RESULT_TEXT_CHARS
  if (!Number.isInteger(maxResultTextChars)
    || maxResultTextChars < MIN_RESULT_TEXT_CHARS
    || maxResultTextChars > MAX_RESULT_TEXT_CHARS) {
    throw new TypeError(
      `maxResultTextChars must be an integer from ${MIN_RESULT_TEXT_CHARS} through ${MAX_RESULT_TEXT_CHARS}`,
    )
  }
  const pageChars = config.pageChars ?? DEFAULT_PAGE_CHARS
  if (!Number.isInteger(pageChars) || pageChars < 1 || pageChars > MAX_PAGE_CHARS) {
    throw new TypeError('pageChars must be an integer from 1 through 50000')
  }
  if (pageChars + CONTINUATION_RESERVE > maxResultTextChars) {
    throw new TypeError(
      `pageChars must leave ${CONTINUATION_RESERVE} characters for continuation guidance within the `
      + `${maxResultTextChars}-character finalized-result limit`,
    )
  }
  return { pageChars, maxResultTextChars }
}

/** Count Unicode code points without allocating an intermediate array. */
function codePointLength(text: string): number {
  let count = 0
  for (const _codePoint of text) count++
  return count
}

/** Slice one string by Unicode code-point offsets. */
function sliceCodePoints(text: string, start: number, end = Number.POSITIVE_INFINITY): string {
  let result = ''
  let index = 0
  for (const codePoint of text) {
    if (index >= end) break
    if (index >= start) result += codePoint
    index++
  }
  return result
}

/** Visit recursively model-visible text while preserving all other blocks. */
function visitResultText(content: readonly ContentBlock[], visit: (text: string) => void): void {
  for (const block of content) {
    if (block.type === 'text') visit(block.text)
    else if (block.type === 'tool-result') visitResultText(block.content, visit)
  }
}

/** Concatenate the complete formatted text retained for artifact recovery. */
function completeResultText(content: readonly ContentBlock[]): string {
  let text = ''
  visitResultText(content, (part) => { text += part })
  return text
}

/** Count all recursively model-visible result text. */
function resultTextLength(content: readonly ContentBlock[]): number {
  let count = 0
  visitResultText(content, (text) => { count += codePointLength(text) })
  return count
}

interface TextLimitState {
  offset: number
  markerInserted: boolean
}

/** Retain aggregate head/tail text in-place while preserving every non-text block. */
function limitResultText(
  content: readonly ContentBlock[],
  total: number,
  maxChars: number,
  markerText: string,
  state: TextLimitState = { offset: 0, markerInserted: false },
): ContentBlock[] {
  const marker = sliceCodePoints(markerText, 0, maxChars)
  const markerChars = codePointLength(marker)
  const retained = maxChars - markerChars
  const headChars = Math.floor(retained / 2)
  const tailChars = retained - headChars
  const tailStart = total - tailChars
  const limited: ContentBlock[] = []

  for (const block of content) {
    if (block.type === 'tool-result') {
      limited.push({ ...block, content: limitResultText(block.content, total, maxChars, markerText, state) })
      continue
    }
    if (block.type !== 'text') {
      limited.push(block)
      continue
    }
    const start = state.offset
    const length = codePointLength(block.text)
    const end = start + length
    const head = start < headChars
      ? sliceCodePoints(block.text, 0, Math.max(0, Math.min(length, headChars - start)))
      : ''
    const tail = end > tailStart
      ? sliceCodePoints(block.text, Math.max(0, tailStart - start))
      : ''
    const insertMarker = !state.markerInserted && end >= headChars
    if (insertMarker) state.markerInserted = true
    const text = head + (insertMarker ? marker : '') + tail
    if (text.length > 0) limited.push({ ...block, text })
    state.offset = end
  }
  return limited
}

/** Best-effort human-readable text for retention diagnostics. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return '<unprintable thrown value>'
  }
}

/** Produce a bounded warning when complete retention cannot be guaranteed. */
function retentionFailure(
  ctx: Context,
  result: Readonly<ToolExecutionResult>,
  maxResultTextChars: number,
  reason: string,
): ToolExecutionFailure {
  ctx.logger.warn(`tool result retention failed: ${reason}`)
  return {
    isError: true,
    error: {
      message: 'complete tool result retention failed',
      info: { name: 'ToolResultRetentionError', code: TOOL_RESULT_RETENTION_FAILED },
    },
    content: limitResultText(
      result.content, resultTextLength(result.content), maxResultTextChars, RETENTION_FAILURE_WARNING),
    ...result.isError ? { originalError: result.error } : { value: result.value },
    ...result.meta !== undefined ? { meta: result.meta } : {},
    ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
  }
}

/** Retain and bound one oversized complete finalized result. */
async function retainResult(
  ctx: Context,
  exec: Readonly<ToolExecution>,
  result: Readonly<ToolExecutionResult>,
  maxResultTextChars: number,
): Promise<ToolExecutionResult> {
  const totalChars = resultTextLength(result.content)
  if (totalChars <= maxResultTextChars) return result
  if (exec.agent === undefined) {
    return retentionFailure(ctx, result, maxResultTextChars, 'the execution has no owning agent session')
  }

  const completeText = completeResultText(result.content)
  try {
    const ref = await ctx.spillStore.saveText({
      signal: exec.signal,
      owner: { sessionId: exec.agent.session.id },
      source: { toolName: exec.name, callId: exec.callId, label: 'full-result' },
      suggestedName: `${exec.name}-result.txt`,
      content: completeText,
    })
    const expectedBytes = Buffer.byteLength(completeText, 'utf8')
    if (ref.bytes !== expectedBytes) {
      throw new Error(`artifact backend reported ${ref.bytes} bytes for ${expectedBytes} retained bytes`)
    }
    const artifact: ToolResultArtifact = {
      kind: 'full-result',
      locator: ref.locator,
      bytes: ref.bytes,
    }
    const marker = `\n[Full result: artifact_read locator="${ref.locator}" (${ref.bytes} bytes)]\n`
    if (codePointLength(marker) > maxResultTextChars) {
      throw new Error('artifact locator does not fit in the configured result-text limit')
    }
    return {
      ...result,
      content: limitResultText(result.content, totalChars, maxResultTextChars, marker),
      artifact,
    }
  } catch (error: unknown) {
    return retentionFailure(ctx, result, maxResultTextChars, errorMessage(error))
  }
}

function renderPage(page: ArtifactPage): string {
  if (page.nextCursor === undefined) return page.text
  if (Array.from(page.nextCursor).length > MAX_CURSOR_CHARS) {
    throw new Error(`artifact backend cursor exceeds ${MAX_CURSOR_CHARS} characters`)
  }
  return page.text
    + CONTINUATION_PREFIX + page.nextCursor + CONTINUATION_SUFFIX
}

function presentCall(locator: string): GenericCallView {
  return {
    card: 'generic',
    title: 'Read artifact',
    kind: 'read',
    rawInput: locator,
  }
}

/**
 * Register complete-result retention and `artifact_read` with fixed deployment limits.
 * @param ctx - Cordis context carrying the tool runtime and spill backend.
 * @param config - Optional finalized-result and artifact-page limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.on('tools/finalize-result', async (exec, _result, next): Promise<ToolExecutionResult> => {
    const result = await next()
    return retainResult(ctx, exec, result, resolved.maxResultTextChars)
  }, { prepend: true })
  ctx.tools.register(defineTool({
    name: 'artifact_read',
    description: 'Read one bounded text page from a stored artifact by opaque locator. Use locators returned by '
      + 'artifact notices, and pass any returned cursor back unchanged to continue. Do not interpret or modify '
      + 'locators or cursors. Returns the exact text page and continuation guidance when more text remains.',
    parameters: {
      locator: {
        type: 'string',
        required: true,
        description: 'Opaque artifact locator returned by the spill backend. Pass it unchanged.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque continuation cursor returned by a previous artifact_read call. Pass it unchanged.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, page) => [{ type: 'text', text: renderPage(page) }],
    },
    execute(args, exec) {
      return ctx.spillStore.readText({
        signal: exec.signal,
        locator: SpillLocator(args.locator),
        ...args.cursor === undefined ? {} : { cursor: args.cursor },
        maxChars: resolved.pageChars,
      })
    },
    presentCall: args => presentCall(args.locator),
  }))
}
