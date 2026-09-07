/**
 * User-message content projection for admitted generic files: suppress the
 * Host's deterministic handle-text blocks from the visible bubble text (the
 * badge row is the user-facing form) and recover badge data from those same
 * blocks when the structured refs are absent (older logs, pending rows).
 *
 * The three-line shape this module matches is pinned to the Host's
 * `fileHandleText` (dsh-attachment/file-handle) — a text block is suppressed
 * only when the WHOLE block equals the handle shape, so user-typed `[文件]`
 * prose is never touched.
 */

/** One recovered file-badge datum (name + byte count). */
export interface HandleFileBadge {
  readonly name: string
  readonly bytes: number
}

const HANDLE_HEAD = /^\[文件\] (.+) · (\d+(?:\.\d+)?) (B|KB|MB|GB|TB) · sha256:[0-9a-f]{8}$/u
const HANDLE_PATH = /^只读路径: \S.*$/u
const HANDLE_USAGE = '用 read 工具读取该路径获得内容；不要凭名字猜测内容。'

/** Parse one handle-text block; undefined when the block is not a handle. */
function parseHandleBlock(text: string): HandleFileBadge | undefined {
  const lines = text.split('\n')
  if (lines.length !== 3) return undefined
  const head = HANDLE_HEAD.exec(lines[0] as string)
  if (head === null) return undefined
  if (!HANDLE_PATH.test(lines[1] as string) || lines[2] !== HANDLE_USAGE) return undefined
  const value = Number.parseFloat(head[2] as string)
  const exponent = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(head[3] as string)
  return { name: head[1] as string, bytes: Math.round(value * 1024 ** exponent) }
}

/**
 * Split one user message's content blocks into the visible text and the file
 * badges recoverable from suppressed handle blocks.
 * @param content - the message's content blocks.
 * @returns the joined visible text (handle blocks removed) and their badges.
 */
export function splitFileHandleText(content: readonly unknown[]): { text: string; badges: HandleFileBadge[] } {
  const texts: string[] = []
  const badges: HandleFileBadge[] = []
  for (const block of content) {
    const text = (block as { type?: unknown; text?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : undefined
    const badge = text === undefined ? undefined : parseHandleBlock(text)
    if (badge !== undefined) badges.push(badge)
    else if (text !== undefined) texts.push(text)
  }
  return { text: texts.join(''), badges }
}
