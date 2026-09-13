/**
 * Default `/proc` internals: the real filesystem seams (`readFile`, `readDir`,
 * `readLink`, `statfs`) the metering readers fall back to when a caller does
 * not inject its own. These default arms read Linux procfs paths directly, so
 * they can only execute on Linux; the Linux coverage lane owns them at the
 * full per-file 100% bar (tests/default-internals.spec.ts), and the Windows
 * lane excludes this file from its coverage scope instead.
 * @module @deepseek-ai/dsh-governor/proc-defaults
 */

import { readFile, readdir, readlink, statfs } from 'node:fs/promises'
import type { ProcInternals } from './types.ts'

/**
 * The real-filesystem internals the metering readers use when a caller
 * injects none: straight `node:fs/promises` seams over procfs paths.
 */
export const defaultInternals: ProcInternals = {
  readFile: path => readFile(path, 'utf8'),
  readDir: path => readdir(path),
  readLink: path => readlink(path),
  statfs: async (path) => {
    const stats = await statfs(path)
    return { bavail: stats.bavail, bsize: stats.bsize }
  },
}
