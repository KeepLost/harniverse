/** Exclusive process-lifetime ownership of a canonical DSH home or one profile within it. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

interface Owner { pid: number; nonce: string }

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const filename = (owner: Owner): string => `owner-${owner.nonce}.json`

async function readOwner(root: string): Promise<Owner | undefined> {
  const files = await readdir(root)
  if (files.length === 0) return undefined
  const file = files[0]
  if (files.length !== 1 || file === undefined || !/^owner-[a-f0-9]{32}\.json$/.test(file)) {
    throw new Error(`dsh: invalid home owner at ${root}`)
  }
  const value: unknown = JSON.parse(await readFile(join(root, file), 'utf8'))
  if (typeof value !== 'object' || value === null
    || !Number.isSafeInteger((value as Owner).pid) || (value as Owner).pid <= 0
    || typeof (value as Owner).nonce !== 'string' || file !== filename(value as Owner)) {
    throw new Error(`dsh: invalid home owner at ${root}`)
  }
  return value as Owner
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return code(error) !== 'ESRCH' }
}

/**
 * Own the canonical home before profile preparation or provider writes.
 * @param configured - optional Harness home override; otherwise `$DSH_HOME` or `~/.dsh`.
 * @param options - an optional profile name restricts the lease to that profile's files, independently of the home lease.
 * @returns a process-lifetime lease with idempotent async release.
 * @throws when another live process owns the selected scope or the owner record is invalid.
 */
export async function acquireHomeOwnership(
  configured?: string, options: { profile?: string } = {},
): Promise<{ release(): Promise<void> }> {
  const home = await canonicalizeWatchPath(resolveDshHome(configured))
  const runtime = join(home, 'runtime')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  const root = join(runtime, options.profile === undefined ? 'instance.lease' : `profile-${encodeURIComponent(options.profile)}.lease`)
  const owner: Owner = { pid: process.pid, nonce: randomBytes(16).toString('hex') }
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `${root}.${owner.nonce}.tmp`
    await mkdir(candidate, { mode: 0o700 })
    try {
      await writeFile(join(candidate, filename(owner)), JSON.stringify(owner), { mode: 0o600 })
    } catch (error) {
      await rm(candidate, { recursive: true, force: true })
      throw error
    }
    try {
      await rename(candidate, root)
      let releasePromise: Promise<void> | undefined
      return {
        release() {
          return releasePromise ??= (async () => {
            const current = await readOwner(root)
            if (current?.nonce !== owner.nonce || current.pid !== owner.pid) {
              throw new Error('dsh: refusing to release a home owned by another process')
            }
            await rm(join(root, filename(owner)))
            try { await rmdir(root) } catch (error) {
              // Unlink relinquishes ownership; a successor may already occupy the directory.
              if (!['ENOTEMPTY', 'ENOENT', 'EPERM'].includes(code(error) ?? '')) throw error
            }
          })()
        },
      }
    } catch (error) {
      await rm(candidate, { recursive: true, force: true })
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code(error) ?? '')) throw error
    }
    let current: Owner | undefined
    try { current = await readOwner(root) } catch (error) {
      if (code(error) === 'ENOENT' || (process.platform === 'win32' && code(error) === 'EPERM')) continue
      throw error
    }
    if (current !== undefined && alive(current.pid)) {
      const scope = options.profile === undefined ? home : `${home} profile ${JSON.stringify(options.profile)}`
      throw new Error(`dsh: Harniverse already running for ${scope} (pid ${current.pid})`)
    }
    if (current !== undefined) {
      try { await rm(join(root, filename(current))) } catch (error) {
        if (code(error) !== 'ENOENT' && code(error) !== 'EPERM') throw error
      }
    }
    try { await rmdir(root) } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EPERM'].includes(code(error) ?? '')) throw error
    }
  }
  throw new Error(`dsh: could not acquire home ownership for ${home}`)
}
