/**
 * Model-facing paged text reader over the `ctx.spillStore` capability.
 * @module @deepseek-ai/dsh-tool-artifact-read
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

const DEFAULT_PAGE_CHARS = 12_000
const MAX_PAGE_CHARS = 50_000
const MAX_CURSOR_CHARS = 128
const CONTINUATION_PREFIX = '\n\nContinue with artifact_read using the same locator and cursor "'
const CONTINUATION_SUFFIX = '".'
const CONTINUATION_RESERVE = Array.from(CONTINUATION_PREFIX).length
  + MAX_CURSOR_CHARS
  + Array.from(CONTINUATION_SUFFIX).length

/** Cordis function-plugin name. */
export const name = 'tool-artifact-read'

/** Services required to register and execute `artifact_read`. */
export const inject = ['tools', 'spillStore']

/** Deployment-selected artifact page size. */
export interface Config {
  /** Maximum Unicode code points requested from the backend per call. */
  pageChars?: number
}

/** Loader config schema for artifact paging. */
export const Config: z<Config> = z.object({
  pageChars: z.number().step(1).min(1).max(MAX_PAGE_CHARS).default(DEFAULT_PAGE_CHARS),
})

interface ResolvedConfig {
  readonly pageChars: number
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

function resolveConfig(config: Config, resultTextLimit: number): ResolvedConfig {
  const pageChars = config.pageChars ?? DEFAULT_PAGE_CHARS
  if (!Number.isInteger(pageChars) || pageChars < 1 || pageChars > MAX_PAGE_CHARS) {
    throw new TypeError('pageChars must be an integer from 1 through 50000')
  }
  if (pageChars + CONTINUATION_RESERVE > resultTextLimit) {
    throw new TypeError(
      `pageChars must leave ${CONTINUATION_RESERVE} characters for continuation guidance within the `
      + `${resultTextLimit}-character ToolRuntime result limit`,
    )
  }
  return { pageChars }
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
 * Register the `artifact_read` tool with a fixed deployment page size.
 * @param ctx - Cordis context carrying the tool runtime and spill backend.
 * @param config - Optional page-size configuration; omitted values resolve to 12,000 characters.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config, ctx.tools.maxResultTextChars)
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
