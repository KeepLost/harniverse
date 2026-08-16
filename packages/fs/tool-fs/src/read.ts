/**
 * Model-facing UTF-8 read. It performs one provider stat for type, routing, and observed version,
 * always streams files, renders a bounded window, then emits the observation.
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
}

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
  lineByteOffset: number
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function parseNonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(
  args: { file_path: string; offset?: number; limit?: number; line_byte_offset?: number },
  maxLimit: number,
): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  const lineByteOffset = args.line_byte_offset === undefined
    ? 0
    : parseNonNegativeInteger(args.line_byte_offset, 'line_byte_offset')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit, lineByteOffset }
}

/**
 * Register the `read` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Pass returned offset and line_byte_offset values unchanged to continue partial long lines.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
      line_byte_offset: {
        type: 'number',
        description: '0-based UTF-8 byte cursor within the first selected line. Use only a cursor returned by read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                startByte: { type: 'integer' },
                endByte: { type: 'integer' },
                complete: { type: 'boolean' },
              },
            },
          },
          totalLines: { type: 'integer' },
          next: {
            type: 'object',
            additionalProperties: false,
            properties: {
              offset: { type: 'integer', required: true },
              lineByteOffset: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        parseReadArgs(args, caps.limit)
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            ...value.totalLines === undefined ? {} : { totalLines: value.totalLines },
            ...value.next === undefined ? {} : { next: value.next },
          }),
        }]
      },
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay: the raw canonical output object is not on the wire, only
      // the model-facing text, from which the line/lang data cannot be recovered.
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(line => ({ ...line })),
          ...value.totalLines === undefined ? {} : { totalLines: value.totalLines },
          ...value.next === undefined ? {} : { next: value.next },
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      // One stat: absence observation OR type check + present version.
      // A concurrent write can only make a later guarded mutation fail stale and require reread.
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)
      const chunks = await ctx.fs.streamText(target, exec.signal)
      const window = await buildWindow(
        chunks,
        {
          offset: input.offset,
          lineByteOffset: input.lineByteOffset,
          limit: input.limit,
          maxLineLength: caps.maxLineLength,
          maxBytes: caps.maxBytes,
        },
        target.displayPath,
      )

      const outcome = {
        path: target.displayPath,
        offset: input.offset,
        lines: window.lines,
        ...window.totalLines === undefined ? {} : { totalLines: window.totalLines },
        ...window.next === undefined ? {} : { next: window.next },
      }
      // Record the present observation (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Result-time display: a `read` card carrying the structured line window a
    // capable UI renders as a line-numbered, syntax-highlighted view. The
    // structured data is narrowed from the persisted `meta` (replay-safe); the
    // envelope-stripped model-facing text rides along as `content` so a UI without
    // the read capability still shows the file text. A malformed or absent meta,
    // or a result whose text is not the read envelope, declines to `undefined`
    // (the generic fallback), never throwing on replay of obsolete logged output.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        ...meta.totalLines === undefined ? {} : { totalLines: meta.totalLines },
        ...meta.next === undefined ? {} : { next: meta.next },
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // Pure display: a generic card titled by the file with the read window appended (`Read
    // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
    // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
    // the title bare instead of smuggling config into this pure presenter.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
