/** Browser-safe grammar for an active `@file` token. */

import type { FileReferenceCandidate } from './types.ts'

/** Active token ending at the editor cursor. */
export interface ActiveAtToken {
  prefix: string
  query: string
  quoted: boolean
}

/**
 * Extract an `@path` or open `@"path with spaces` token at the cursor.
 * @param line - editor text through and beyond the cursor.
 * @param cursorCol - cursor offset in the editor text.
 * @returns the active token or undefined when no file token is present.
 */
export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true }
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor)
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined
  return { prefix: plain[1], query: plain[2], quoted: false }
}

/**
 * Format a selected candidate as ordinary prompt text.
 * @param candidate - path-only candidate returned by a provider.
 * @param preserveQuote - whether the active token uses an open quote.
 * @returns ordinary file mention text or undefined for unsafe path data.
 */
export function formatFileMention(candidate: FileReferenceCandidate, preserveQuote: boolean): string | undefined {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  if (candidate.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}
