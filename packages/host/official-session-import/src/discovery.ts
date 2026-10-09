/**
 * Discovery of official DeepSeek Harness session logs on disk. Official builds
 * file each session as `<root>/<project>/<session>/session.vN.jsonl[.zstd]`
 * and keep every older generation beside the newest one; discovery reports
 * only the newest generation of each session directory and resolves opaque
 * source ids back to paths without ever leaving the configured roots.
 *
 * @module @deepseek-ai/dsh-host-official-session-import/discovery
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Official generation log names: `session.v<N>.jsonl` plus optional `.zstd`. */
const GENERATION_LOG = /^session\.v([1-9][0-9]*)\.jsonl(?:\.zstd)?$/u

/** One discovered newest-generation log. */
export interface DiscoveredLog {
  /** Opaque, root-relative identity: `<root index>/<project>/<session>/<file>`. */
  readonly sourceId: string
  /** Absolute path of the log. */
  readonly path: string
}

/** A root or directory that could not be listed. */
export interface DiscoveryFailure {
  readonly path: string
  readonly message: string
}

/** Everything one discovery pass found. */
export interface Discovery {
  readonly logs: readonly DiscoveredLog[]
  readonly failures: readonly DiscoveryFailure[]
}

/**
 * The newest official generation among one session directory's file names.
 * @param names - the directory's entry names.
 * @returns the newest generation log name, or undefined when none is present.
 */
export function newestGeneration(names: readonly string[]): string | undefined {
  let best: { name: string; version: number } | undefined
  for (const name of names) {
    const match = GENERATION_LOG.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    // Equal generations differ only by encoding; the compressed one sorts last.
    if (best === undefined || version > best.version || (version === best.version && name > best.name)) {
      best = { name, version }
    }
  }
  return best?.name
}

async function directories(path: string, failures: DiscoveryFailure[]): Promise<string[] | undefined> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    // A root that does not exist simply holds no official sessions.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      failures.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
    return undefined
  }
}

/**
 * List the newest official generation log of every session directory under
 * the given roots, in a stable order.
 * @param roots - absolute session roots, in configured order.
 * @param signal - cancellation between directory reads.
 * @returns the discovered logs and every directory that could not be listed.
 */
export async function discoverOfficialLogs(roots: readonly string[], signal?: AbortSignal): Promise<Discovery> {
  const logs: DiscoveredLog[] = []
  const failures: DiscoveryFailure[] = []
  for (const [index, root] of roots.entries()) {
    signal?.throwIfAborted()
    for (const project of await directories(root, failures) ?? []) {
      signal?.throwIfAborted()
      for (const session of await directories(join(root, project), failures) ?? []) {
        let names: string[]
        try {
          names = await readdir(join(root, project, session))
        } catch (error) {
          failures.push({ path: join(root, project, session), message: error instanceof Error ? error.message : String(error) })
          continue
        }
        const newest = newestGeneration(names)
        if (newest === undefined) continue
        logs.push({ sourceId: `${index}/${project}/${session}/${newest}`, path: join(root, project, session, newest) })
      }
    }
  }
  return { logs, failures }
}

/**
 * Resolve one opaque source id back to its log path, refusing anything that
 * is not a generation log exactly three levels below a configured root.
 * @param roots - the configured roots the id was minted against.
 * @param sourceId - the opaque id from a discovery pass.
 * @returns the absolute log path, or undefined for a malformed or escaping id.
 */
export function resolveSourceId(roots: readonly string[], sourceId: string): string | undefined {
  const [index = '', ...segments] = sourceId.split('/')
  if (!/^(?:0|[1-9][0-9]*)$/u.test(index)) return undefined
  const root = roots[Number(index)]
  if (root === undefined || segments.length !== 3) return undefined
  // Plain names only: no traversal, no separator of either platform, and no
  // drive or stream syntax, so joining can never leave the root.
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[^\\/:\0]+$/u.test(segment))) return undefined
  if (!GENERATION_LOG.test(segments[2] as string)) return undefined
  return join(root, ...segments)
}
