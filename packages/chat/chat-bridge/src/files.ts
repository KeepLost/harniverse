/**
 * Outbound file validation. Only a regular, non-symlink file whose real path
 * lies inside the session's working directory and within the size cap may
 * leave through a chat.
 * @module @deepseek-ai/dsh-chat-bridge/files
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import type { OutboundFile } from '@deepseek-ai/dsh-chat-adapter'

/** Outcome of validating one presented file. */
export type Deliverable =
  | { ok: true; file: OutboundFile }
  | { ok: false; reason: string }

/**
 * Validate one file the model presented.
 * @param cwd - the session's working directory.
 * @param path - the presented path, absolute or relative to `cwd`.
 * @param maxBytes - size cap.
 * @returns the file to send, or why it must not be sent.
 */
export async function checkDeliverable(cwd: string, path: string, maxBytes: number): Promise<Deliverable> {
  const target = resolve(cwd, path)
  let link: Awaited<ReturnType<typeof lstat>>
  let root: string
  try {
    root = await realpath(cwd)
    link = await lstat(target)
  } catch {
    // A missing workspace or file is reported, never thrown: the model may present a path that was deleted.
    return { ok: false, reason: 'file not found' }
  }
  if (link.isSymbolicLink()) return { ok: false, reason: 'symbolic links are not delivered' }
  const real = await realpath(target)
  if (real !== root && !real.startsWith(root + sep)) return { ok: false, reason: 'file is outside the session workspace' }
  const info = await stat(real)
  if (!info.isFile()) return { ok: false, reason: 'not a regular file' }
  if (info.size > maxBytes) return { ok: false, reason: `file is larger than ${String(maxBytes)} bytes` }
  return { ok: true, file: { filePath: real, fileName: basename(real), bytes: info.size } }
}
