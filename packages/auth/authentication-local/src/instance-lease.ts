/** Process-lifetime exclusive lease for one DSH home's network server. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthenticationMode } from '@deepseek-ai/dsh-authentication'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ensurePrivateDirectory, isMissing, isProcessAlive, writePrivateFile } from './private-files.ts'

interface LeaseOwner {
  version: 1
  mode: AuthenticationMode
  pid: number
  nonce: string
  startedAt: string
}

// Windows reports an existing destination directory as EPERM rather than EEXIST.
const LEASE_CONTENTION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM'])

// Removing a vacated lease races every other acquirer's cleanup and creation.
// POSIX reports a repopulated directory as ENOTEMPTY; Windows reports a
// directory another process still holds open as EPERM.
const LEASE_CLEANUP_CONTENTION_CODES = new Set(['ENOTEMPTY', 'EPERM'])

// Contended cleanup retries against a live competitor, so acquisition is
// bounded: an unremovable lease directory fails loudly instead of spinning.
const MAX_LEASE_ACQUIRE_ATTEMPTS = 64

/**
 * Remove a lease directory whose owner is gone, tolerating a competing
 * acquirer that repopulated or still holds it.
 * @param root - the lease directory to remove.
 */
async function removeVacatedLease(root: string): Promise<void> {
  try {
    await rmdir(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (isMissing(error)) return
    if (code === undefined || !LEASE_CLEANUP_CONTENTION_CODES.has(code)) throw error
  }
}

/** Options selecting the DSH home and process authentication mode. */
export interface AuthenticationLeaseOptions {
  dshHome?: string
  mode: AuthenticationMode
}

/** Acquired process-lifetime network instance lease. */
export interface AuthenticationLease {
  mode: AuthenticationMode
  release(): Promise<void>
}

function leaseRoot(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'runtime', 'inbound-authentication.lease')
}

function parseOwner(text: string, path: string): LeaseOwner {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null
    || (value as { version?: unknown }).version !== 1
    || !['authenticated', 'bypass'].includes(String((value as { mode?: unknown }).mode))
    || !Number.isSafeInteger((value as { pid?: unknown }).pid)
    || (value as { pid: number }).pid <= 0
    || typeof (value as { nonce?: unknown }).nonce !== 'string'
    || typeof (value as { startedAt?: unknown }).startedAt !== 'string') {
    throw new Error(`authentication-local: invalid instance lease at ${path}`)
  }
  return value as LeaseOwner
}

function ownerFilename(owner: LeaseOwner): string {
  return `owner-${owner.nonce}.json`
}

async function readOwner(root: string): Promise<{ owner: LeaseOwner; filename: string } | undefined> {
  const [filename, ...extra] = await readdir(root)
  // An empty lease directory is a vacated lease, not a malformed one.
  if (filename === undefined) return undefined
  if (extra.length > 0 || !/^owner-[a-f0-9]{32}\.json$/.test(filename)) {
    throw new Error(`authentication-local: invalid instance lease at ${root}`)
  }
  const owner = parseOwner(await readFile(join(root, filename), 'utf8'), root)
  if (filename !== ownerFilename(owner)) throw new Error(`authentication-local: invalid instance lease at ${root}`)
  return { owner, filename }
}

/**
 * Acquire the sole network-serving lease for one DSH home.
 * @param options - Harness home and selected authentication mode.
 * @returns the owned lease and its idempotent release operation.
 */
export async function acquireAuthenticationLease(options: AuthenticationLeaseOptions): Promise<AuthenticationLease> {
  const runtime = join(resolveDshHome(options.dshHome), 'runtime')
  await ensurePrivateDirectory(runtime)
  const root = leaseRoot(options.dshHome)
  const nonce = randomBytes(16).toString('hex')
  const owner: LeaseOwner = {
    version: 1,
    mode: options.mode,
    pid: process.pid,
    nonce,
    startedAt: new Date().toISOString(),
  }
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= MAX_LEASE_ACQUIRE_ATTEMPTS) {
      throw new Error(`authentication-local: could not acquire the instance lease in ${String(MAX_LEASE_ACQUIRE_ATTEMPTS)} attempts`)
    }
    const candidate = `${root}.${nonce}.tmp`
    await mkdir(candidate, { mode: 0o700 })
    await writePrivateFile(join(candidate, ownerFilename(owner)), `${JSON.stringify(owner, null, 2)}\n`)
    try {
      await rename(candidate, root)
      break
    } catch (error) {
      await rm(candidate, { recursive: true, force: true })
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === undefined || !LEASE_CONTENTION_CODES.has(code)) throw error
    }
    let current: Awaited<ReturnType<typeof readOwner>>
    try {
      current = await readOwner(root)
    } catch (error) {
      // A competing Windows cleanup can remove the owner between readdir and
      // readFile, which surfaces as EPERM instead of ENOENT.
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (isMissing(error) || code === 'EPERM') continue
      throw error
    }
    if (current === undefined) {
      await removeVacatedLease(root)
      continue
    }
    if (isProcessAlive(current.owner.pid)) {
      throw new Error(`authentication-local: Harniverse network instance already running in ${current.owner.mode} mode with pid ${String(current.owner.pid)}`)
    }
    await rm(join(root, current.filename), { force: true })
    await removeVacatedLease(root)
  }

  let released = false
  return {
    mode: options.mode,
    async release() {
      if (released) return
      const current = await readOwner(root)
      if (current === undefined) throw new Error('authentication-local: instance lease owner disappeared before release')
      if (current.owner.pid !== owner.pid || current.owner.nonce !== owner.nonce) {
        throw new Error('authentication-local: refusing to release an instance lease owned by another process')
      }
      await rm(join(root, current.filename), { force: true })
      await rmdir(root)
      released = true
    },
  }
}
