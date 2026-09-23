/** Exclusive ownership of a dedicated desktop home; never cleans an arbitrary Harness home. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'

/** Claim an empty or marked desktop directory; authentication-local owns the crash-recoverable process lease. */
export async function claimDesktopHome(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) === parse(path).root) throw new Error('Desktop requires an absolute private home.')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Desktop home must be a real directory.')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Desktop home must be private to its owner (0700).')
  const home = await realpath(path)
  if (home === resolve(homedir()) || home === resolve(homedir(), '.dsh')) throw new Error('Desktop cannot own the default user home.')
  const marker = join(home, '.desktop-owned')
  const entries = await readdir(home)
  if (entries.length === 0) {
    const file = await open(marker, 'wx', 0o600)
    try { await file.writeFile('harniverse-desktop-host-v1\n') } finally { await file.close() }
  }
  const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (await file.readFile('utf8') !== 'harniverse-desktop-host-v1\n') throw new Error('Unrecognized desktop home ownership.')
  } finally { await file.close() }
  return home
}
