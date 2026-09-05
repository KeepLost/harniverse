/**
 * Model-facing `str_replace_editor` over the Harness filesystem seam.
 * @module @deepseek-ai/dsh-tool-str-replace-editor
 */

import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { buildWindow } from '@deepseek-ai/dsh-tool-fs/read-render'
import type { FileTextLine, ReadCursor } from '@deepseek-ai/dsh-tool-fs/read-render'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const DEFAULT_MAX_MUTATION_INPUT_BYTES = 16 * 1024 * 1024
const MIN_MAX_OUTPUT_CHARS = 512
const FILE_VIEW_OVERHEAD_RESERVE = 512
const TRAILING_EMPTY_LINE_SENTINEL = '\0'

const DEFAULT_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim()

function maybeTruncate(content: string, maxOutputChars: number): string {
  if (content.length <= maxOutputChars) return content
  return content.slice(0, maxOutputChars - TRUNCATED_MESSAGE.length) + TRUNCATED_MESSAGE
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = []
  let offset = 0
  while (true) {
    const match = content.indexOf(search, offset)
    if (match < 0) return offsets
    offsets.push(match)
    offset = match + search.length
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1
  let cursor = 0
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === '\n') line += 1
      cursor += 1
    }
    return line
  })
}

class MutationPolicy {
  private readonly policy: SandboxPolicyService | undefined

  constructor(ctx: Context) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error('tool-str-replace-editor: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  resolve(exec: ToolRunContext): SandboxExecutionPolicy | undefined {
    return this.policy?.resolve({
      ...exec.agent === undefined ? {} : { session: exec.agent.session },
    })
  }

  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(sandboxDenialMarker(mode), 'FS_SANDBOX_DENIED', { cause: error })
  }
}

async function resolveTarget(
  ctx: Context,
  path: string,
  signal: AbortSignal,
): Promise<FsTarget> {
  if (path.trim().length === 0) throw new Error('path must be a non-empty string')
  if (!isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`)
  }
  return ctx.fs.resolve(path, { signal })
}

async function statExisting(
  ctx: Context,
  target: FsTarget,
  command: 'view' | 'str_replace' | 'insert',
  exec: ToolRunContext,
): Promise<FsInfo> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(
      `The path ${target.displayPath} does not exist. Please provide a valid path.`,
      'FS_NOT_FOUND',
    )
  }
  if (info.type === 'directory' && command !== 'view') {
    throw new FsError(
      `The path ${target.displayPath} is a directory and only the \`view\` command can be used on directories`,
      'FS_NOT_REGULAR_FILE',
    )
  }
  return info
}

function requiredForCommand(
  value: string | undefined,
  parameter: string,
  command: string,
  allowEmpty = true,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`)
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`)
  }
  return value
}

interface FileViewWindow {
  lines: FileTextLine[]
  totalLines?: number
  next?: ReadCursor
}

function validateViewRange(viewRange: number[] | undefined): { initialLine: number; finalLine?: number } {
  if (viewRange === undefined) return { initialLine: 1 }
  const [initialLine, finalLine] = viewRange
  if (
    viewRange.length !== 2
    || initialLine === undefined
    || finalLine === undefined
    || !viewRange.every(Number.isInteger)
  ) {
    throw new Error('Invalid `view_range`. It should be a list of two integers.')
  }
  if (initialLine < 1) {
    throw new Error(
      `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, unknown]`,
    )
  }
  if (finalLine !== -1 && finalLine < initialLine) {
    throw new Error(
      `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
    )
  }
  return { initialLine, finalLine }
}

function formatFileView(
  path: string,
  window: FileViewWindow,
  viewRange?: number[],
): string {
  const initialLine = viewRange?.[0] ?? 1
  const finalLine = viewRange?.[1]
  let prompt = window.totalLines === undefined
    ? `Here's a bounded portion of ${path} with line numbers`
    : `Here's the content of ${path} with line numbers (which has a total of ${window.totalLines} lines)`
  if (viewRange !== undefined) {
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`
  }
  const numbered = window.lines
    .map(line => `${String(line.number).padStart(6, ' ')}  ${line.text}`)
    .join('\n')
  let continuation = ''
  if (window.next?.lineByteOffset) {
    continuation = `\n<response clipped>\n(Line ${window.next.offset} continues. Use command=view, view_range=[${window.next.offset}, ${finalLine ?? -1}], and line_byte_offset=${window.next.lineByteOffset}.)`
  } else if (window.next !== undefined) {
    continuation = `\n<response clipped>\n(Use command=view and view_range=[${window.next.offset}, ${finalLine ?? -1}] to continue.)`
  }
  return `${prompt}:\n${numbered}\n${continuation}`
}

async function listDirectory(
  ctx: Context,
  target: FsTarget,
  maxOutputChars: number,
  exec: ToolRunContext,
): Promise<string> {
  async function visit(dir: FsTarget, depth: number): Promise<string[]> {
    const entries = await ctx.fs.listDir(dir, exec.signal)
    const rows: string[] = []
    for (const entry of entries.filter(candidate =>
      !candidate.name.startsWith('.')
      && candidate.name !== 'node_modules'
      && candidate.name !== '__pycache__')) {
      const type = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?'
      rows.push(`${type}\t${entry.target.displayPath}`)
      if (entry.type === 'directory' && depth < 2) {
        rows.push(...await visit(entry.target, depth + 1))
      }
    }
    return rows
  }
  const rows = [`d\t${target.displayPath}`, ...await visit(target, 1)]
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf('\t') + 1)
    const rightPath = right.slice(right.indexOf('\t') + 1)
    return codepointCompare(leftPath, rightPath)
  })
  return maybeTruncate(
    `Here're the files and directories up to 2 levels deep in ${target.displayPath}, excluding hidden items, node_modules, and Python cache directories:\n${rows.join('\n')}\n\n`,
    maxOutputChars,
  )
}

async function viewPath(
  ctx: Context,
  path: string,
  viewRange: number[] | undefined,
  lineByteOffset: number | undefined,
  maxOutputChars: number,
  exec: ToolRunContext,
): Promise<string> {
  const { initialLine, finalLine } = validateViewRange(viewRange)
  const target = await resolveTarget(ctx, path, exec.signal)
  const info = await statExisting(ctx, target, 'view', exec)
  if (info.type === 'directory') {
    if (viewRange !== undefined) {
      throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
    }
    if (lineByteOffset !== undefined) {
      throw new Error('The `line_byte_offset` parameter is not allowed when `path` points to a directory.')
    }
    return listDirectory(ctx, target, maxOutputChars, exec)
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot view "${target.displayPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
  }
  const chunks = await ctx.fs.streamText(target, exec.signal)
  async function* preserveTrailingEmptyLine() {
    let sawText = false
    let endsWithNewline = false
    for await (const chunk of chunks) {
      if (chunk.length > 0) {
        sawText = true
        endsWithNewline = chunk.endsWith('\n')
      }
      yield chunk
    }
    if (!sawText || endsWithNewline) yield TRAILING_EMPTY_LINE_SENTINEL
  }
  const requestedLines = finalLine === undefined || finalLine === -1
    ? maxOutputChars
    : finalLine - initialLine + 1
  const contentBudget = Math.max(4, maxOutputChars - FILE_VIEW_OVERHEAD_RESERVE)
  const window = await buildWindow(
    preserveTrailingEmptyLine(),
    {
      offset: initialLine,
      lineByteOffset: lineByteOffset ?? 0,
      limit: Math.min(requestedLines, contentBudget),
      maxLineLength: contentBudget,
      maxBytes: contentBudget,
    },
    target.displayPath,
  )
  if (viewRange !== undefined && window.totalLines !== undefined && finalLine !== undefined && finalLine > window.totalLines) {
    throw new Error(
      `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${window.totalLines}\``,
    )
  }
  const lines = window.lines.map((line) => {
    if (window.totalLines === undefined
      || line.number !== window.totalLines
      || !line.text.endsWith(TRAILING_EMPTY_LINE_SENTINEL)) return line
    return { ...line, text: line.text.slice(0, -TRAILING_EMPTY_LINE_SENTINEL.length) }
  })
  const rangeComplete = finalLine !== undefined
    && finalLine !== -1
    && window.next?.lineByteOffset === 0
    && lines.at(-1)?.number === finalLine
  const viewWindow: FileViewWindow = {
    lines,
    ...window.totalLines === undefined ? {} : { totalLines: window.totalLines },
    ...rangeComplete || window.next === undefined ? {} : { next: window.next },
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return maybeTruncate(formatFileView(target.displayPath, viewWindow, viewRange), maxOutputChars)
}

function assertMutationInputSize(info: FsInfo, target: FsTarget, maxBytes: number): void {
  if (info.size !== undefined && info.size > maxBytes) {
    throw new FsError(
      `Cannot edit ${target.displayPath}: its ${info.size}-byte input exceeds maxMutationInputBytes (${maxBytes} bytes).`,
      'FS_TOO_LARGE',
    )
  }
}

/** Acquire a complete mutation basis without trusting optional or stale stat size. */
async function readMutationInput(
  ctx: Context,
  target: FsTarget,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = []
  let bytes = 0
  for await (const chunk of await ctx.fs.streamText(target, signal)) {
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > maxBytes) {
      throw new FsError(
        `Cannot edit ${target.displayPath}: its input exceeds maxMutationInputBytes (${maxBytes} bytes).`,
        'FS_TOO_LARGE',
      )
    }
    chunks.push(chunk)
  }
  return chunks.join('')
}

async function createFile(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  fileText: string | undefined,
  exec: ToolRunContext,
): Promise<string> {
  const content = requiredForCommand(fileText, 'file_text', 'create')
  const sandboxPolicy = policy.resolve(exec)
  const target = await resolveTarget(ctx, path, exec.signal)
  if (await ctx.fs.stat(target, exec.signal) !== undefined) {
    throw new Error(`File already exists at: ${target.displayPath}. Cannot overwrite files using command \`create\`.`)
  }
  const intent = await ctx.waterfall(
    'fs/write-intent',
    target,
    exec,
    () => ({ kind: 'createIfAbsent' } as const),
  )
  let outcome
  try {
    outcome = await ctx.fs.writeText(
      target,
      content,
      intent,
      exec.signal,
      sandboxPolicy,
    )
  } catch (error: unknown) {
    throw policy.mapError(error, sandboxPolicy)
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return `New file created successfully at: ${target.displayPath}`
}

async function replaceInFile(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  oldStr: string | undefined,
  newStr: string | undefined,
  maxMutationInputBytes: number,
  exec: ToolRunContext,
): Promise<string> {
  const sandboxPolicy = policy.resolve(exec)
  const target = await resolveTarget(ctx, path, exec.signal)
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const oldValue = requiredForCommand(oldStr, 'old_str', 'str_replace', false)
  const newValue = newStr ?? ''
  const info = await statExisting(ctx, target, 'str_replace', exec)
  if (info.type !== 'file') {
    throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  assertMutationInputSize(info, target, maxMutationInputBytes)
  const before = await readMutationInput(ctx, target, maxMutationInputBytes, exec.signal)
  const offsets = matchOffsets(before, oldValue)
  const offset = offsets[0]
  if (offset === undefined) {
    throw new FsError(
      `No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${target.displayPath}.`,
      'FS_EDIT_NOT_FOUND',
    )
  }
  if (offsets.length > 1) {
    const lines = lineNumbersAt(before, offsets)
    throw new FsError(
      `No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(', ')}]. Please ensure it is unique`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  let outcome
  try {
    outcome = await ctx.fs.writeText(
      target,
      before.slice(0, offset) + newValue + before.slice(offset + oldValue.length),
      intent === undefined
        ? { kind: 'replaceIfVersion', version: info.version }
        : { kind: 'replaceIfVersion', version: intent.version },
      exec.signal,
      sandboxPolicy,
    )
  } catch (error: unknown) {
    throw policy.mapError(error, sandboxPolicy)
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return `The file ${target.displayPath} has been edited successfully.`
}

async function insertInFile(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  insertLine: number | undefined,
  newStr: string | undefined,
  maxMutationInputBytes: number,
  exec: ToolRunContext,
): Promise<string> {
  if (insertLine === undefined) throw new Error('Parameter `insert_line` is required for command: insert')
  const value = requiredForCommand(newStr, 'new_str', 'insert')
  const sandboxPolicy = policy.resolve(exec)
  const target = await resolveTarget(ctx, path, exec.signal)
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await statExisting(ctx, target, 'insert', exec)
  if (info.type !== 'file') {
    throw new FsError(`cannot insert into "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  assertMutationInputSize(info, target, maxMutationInputBytes)
  const before = await readMutationInput(ctx, target, maxMutationInputBytes, exec.signal)
  const lines = before.split('\n')
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    )
  }
  const after = [
    ...lines.slice(0, insertLine),
    ...value.split('\n'),
    ...lines.slice(insertLine),
  ].join('\n')
  const expected: FsWriteIntent = intent === undefined
    ? { kind: 'replaceIfVersion', version: info.version }
    : { kind: 'replaceIfVersion', version: intent.version }
  let outcome
  try {
    outcome = await ctx.fs.writeText(target, after, expected, exec.signal, sandboxPolicy)
  } catch (error: unknown) {
    throw policy.mapError(error, sandboxPolicy)
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return `The file ${target.displayPath} has been edited successfully.`
}

interface ResolvedConfig {
  maxOutputChars: number
  maxMutationInputBytes: number
  description: string
}

function presentEditorCall(args: {
  command: 'view' | 'create' | 'str_replace' | 'insert'
  path: string
  file_text?: string
  insert_line?: number
  new_str?: string
  old_str?: string
}): ToolCallView {
  switch (args.command) {
    case 'view':
      return {
        card: 'generic',
        title: `view ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      }
    case 'create':
      return {
        card: 'diff',
        title: `create ${args.path}`,
        diffs: [{ path: args.path, oldText: null, newText: args.file_text ?? '' }],
        locations: [{ path: args.path }],
      }
    case 'str_replace':
      return {
        card: 'diff',
        title: `str_replace ${args.path}`,
        diffs: [{
          path: args.path,
          oldText: args.old_str ?? null,
          newText: args.new_str ?? '',
        }],
        locations: [{ path: args.path }],
      }
    case 'insert':
      return {
        card: 'generic',
        title: `insert ${args.path}`,
        kind: 'edit',
        locations: [{
          path: args.path,
          ...args.insert_line === undefined ? {} : { line: Math.max(1, args.insert_line + 1) },
        }],
      }
  }
}

/** Register the model-facing `str_replace_editor` tool. */
function registerStrReplaceEditor(ctx: Context, config: ResolvedConfig): void {
  const policy = new MutationPolicy(ctx)
  ctx.tools.register(defineTool({
    name: 'str_replace_editor',
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['view', 'create', 'str_replace', 'insert'],
        description: 'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.',
      },
      file_text: {
        type: 'string',
        description: 'Required parameter of `create` command, with the content of the file to be created.',
      },
      insert_line: {
        type: 'integer',
        description: 'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.',
      },
      new_str: {
        type: 'string',
        description: 'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.',
      },
      old_str: {
        type: 'string',
        description: 'Required parameter of `str_replace` command containing the string in `path` to replace.',
      },
      view_range: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.',
      },
      line_byte_offset: {
        type: 'integer',
        description: 'Optional 0-based UTF-8 byte cursor for `view`. Use only the cursor returned when a long line continues.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.line_byte_offset !== undefined) {
        if (args.command !== 'view') {
          throw new Error('Parameter `line_byte_offset` is only allowed for command: view')
        }
        if (!Number.isSafeInteger(args.line_byte_offset) || args.line_byte_offset < 0) {
          throw new Error('Parameter `line_byte_offset` must be a non-negative safe integer')
        }
      }
      switch (args.command) {
        case 'view':
          return viewPath(
            ctx,
            args.path,
            args.view_range,
            args.line_byte_offset,
            config.maxOutputChars,
            exec,
          )
        case 'create':
          return createFile(ctx, policy, args.path, args.file_text, exec)
        case 'str_replace':
          return replaceInFile(
            ctx,
            policy,
            args.path,
            args.old_str,
            args.new_str,
            config.maxMutationInputBytes,
            exec,
          )
        case 'insert':
          return insertInFile(
            ctx,
            policy,
            args.path,
            args.insert_line,
            args.new_str,
            config.maxMutationInputBytes,
            exec,
          )
      }
    },
    presentCall: presentEditorCall,
  }))
}

export const name = 'tool-str-replace-editor'
export const inject = ['tools', 'fs']

/** Configuration for the string-replacement editor tool. */
export interface Config {
  /** Maximum complete view-response characters, including formatting (default 16000, minimum 512). */
  maxOutputChars?: number
  /** Maximum whole-file input bytes accepted by mutation commands (default 16 MiB). */
  maxMutationInputBytes?: number
  /** Model-facing tool description. */
  description?: string
}

/** Runtime configuration schema for the string-replacement editor tool. */
export const Config: z<Config> = z.object({
  maxOutputChars: z.number().step(1).min(MIN_MAX_OUTPUT_CHARS).default(16_000),
  maxMutationInputBytes: z.number().default(DEFAULT_MAX_MUTATION_INPUT_BYTES),
  description: z.string().default(DEFAULT_DESCRIPTION),
})

/** Register one `str_replace_editor` tool over `ctx.fs`. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    maxOutputChars: config.maxOutputChars ?? 16_000,
    maxMutationInputBytes: config.maxMutationInputBytes ?? DEFAULT_MAX_MUTATION_INPUT_BYTES,
    description: config.description ?? DEFAULT_DESCRIPTION,
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars < MIN_MAX_OUTPUT_CHARS) {
    throw new Error(`tool-str-replace-editor: maxOutputChars must be a safe integer of at least ${MIN_MAX_OUTPUT_CHARS}`)
  }
  if (!Number.isSafeInteger(resolved.maxMutationInputBytes) || resolved.maxMutationInputBytes <= 0) {
    throw new Error('tool-str-replace-editor: maxMutationInputBytes must be a positive safe integer')
  }
  if (resolved.description.trim().length === 0) {
    throw new Error('tool-str-replace-editor: description must be non-empty')
  }
  registerStrReplaceEditor(ctx, resolved)
}
