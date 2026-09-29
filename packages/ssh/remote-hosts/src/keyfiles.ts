/** One-level host directory listing for the browse key-file interaction: directories to enter, files to pick. */
import type { Dirent } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { KeyFileEntry, KeyFileListing } from './types.ts'
import { RemoteHostsError } from './validation.ts'

/** Complete-result bound of one listed level. */
export const KEY_LISTING_MAX_ENTRIES = 1000

/** The entry's kind after following a symbolic link; undefined for a link that resolves nowhere. */
async function entryKind(directory: string, dirent: Dirent): Promise<KeyFileEntry['kind'] | undefined> {
  if (dirent.isDirectory()) return 'directory'
  if (!dirent.isSymbolicLink()) return 'file'
  try {
    const info = await stat(join(directory, dirent.name))
    return info.isDirectory() ? 'directory' : 'file'
  } catch {
    // A broken or cyclic link names nothing to enter or pick.
    return undefined
  }
}

/** The operator's `~/.ssh` when it exists, else the home directory. */
async function defaultDirectory(): Promise<string> {
  const ssh = join(homedir(), '.ssh')
  try {
    await access(ssh)
    return ssh
  } catch {
    // No `.ssh` yet: the home directory is the next useful start.
    return homedir()
  }
}

/**
 * List one host directory level for key picking.
 * @param path - absolute directory; absent starts at `~/.ssh`, else the home directory.
 * @returns directories first, then files, each name-sorted and bounded.
 * @throws {RemoteHostsError} `KEY_DIRECTORY_UNREADABLE` when the level cannot be listed.
 */
export async function listKeyDirectory(path?: string): Promise<KeyFileListing> {
  const directory = resolve(path ?? await defaultDirectory())
  let dirents: Dirent[]
  try {
    // ponytail: readdir materializes the whole level before the bound applies;
    // key directories are small, so stream with a bounded window only if a
    // real caller browses levels with hundreds of thousands of entries.
    dirents = await readdir(directory, { withFileTypes: true })
  } catch {
    throw new RemoteHostsError('KEY_DIRECTORY_UNREADABLE')
  }
  const entries: KeyFileEntry[] = []
  for (const dirent of dirents) {
    const kind = await entryKind(directory, dirent)
    if (kind !== undefined) entries.push({ name: dirent.name, path: join(directory, dirent.name), kind })
  }
  entries.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1)
  const parent = dirname(directory)
  return {
    path: directory,
    ...(parent === directory ? {} : { parent }),
    entries: entries.slice(0, KEY_LISTING_MAX_ENTRIES),
    truncated: entries.length > KEY_LISTING_MAX_ENTRIES,
  }
}
