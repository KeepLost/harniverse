/** Verified local artifacts and atomically persisted recovery records belong to the main process. */
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createUpdate, parseUpdateJournal } from './update-journal.ts'
import type { ReleaseManifest, UpdateRecord } from './update.ts'

/** Distribution identity and writable state directory are supplied only by the native main process. */
export interface UpdateIdentity {
  version: string
  platform: string
  arch: string
  directory: string
  appImage?: string
}

const digestPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

/**
 * Validate an adjacent release manifest against the running product and selected artifact name.
 * @param value - untrusted release JSON.
 * @param identity - current distribution metadata.
 * @param artifact - exact selected filename.
 * @returns a validated manifest for a strictly newer native release.
 */
export function parseReleaseManifest(value: unknown, identity: UpdateIdentity, artifact: string): ReleaseManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid release manifest.')
  const input = value as Partial<ReleaseManifest>
  if (input.schemaVersion !== 1 || input.product !== 'dsh-harniverse' || input.appId !== 'com.keeplost.harniverse'
    || input.platform !== identity.platform || input.arch !== identity.arch || !['x64', 'arm64'].includes(input.arch)
    || input.artifact !== artifact || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(artifact)
    || typeof input.version !== 'string' || typeof input.sha256 !== 'string' || !digestPattern.test(input.sha256)) {
    throw new Error('The release manifest does not match this product, platform, architecture or artifact.')
  }
  const extensions: Record<string, string | undefined> = { linux: '.AppImage', win32: '.exe', darwin: '.dmg' }
  const extension = extensions[input.platform]
  if (extension === undefined || extname(artifact) !== extension) throw new Error('Unsupported native release artifact.')
  createUpdate({ current: identity.version, next: input.version, artifact, sha256: input.sha256 })
  return input as ReleaseManifest
}

/**
 * Hash only a regular file opened without following a final symlink.
 * @param path - main-process artifact or retained executable path.
 * @returns its lowercase SHA-256 digest.
 */
export async function artifactSha256(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error('The update artifact must be a regular file.')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } finally { await file.close() }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not permit fsync on directory handles; file flush and atomic rename remain mandatory.
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid update metadata file.')
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally { await file.close() }
}

async function durableCopy(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o700)
  const file = await open(destination, 'r+')
  try { await file.sync() } finally { await file.close() }
  await syncDirectory(dirname(destination))
}

/** Durable records contain verified metadata, never an arbitrary command or renderer-controlled path. */
export class UpdateFiles {
  constructor(readonly identity: UpdateIdentity) {}

  /**
   * Copy and verify the selected artifact before presenting consent.
   * @param path - artifact selected through the native dialog.
   * @returns private staged metadata and optional verified rollback target.
   */
  async stage(path: string): Promise<UpdateRecord> {
    const artifact = basename(path)
    const manifest = parseReleaseManifest(await readJson(`${path}.manifest.json`), this.identity, artifact)
    if (!(await lstat(path)).isFile()) throw new Error('Select a regular release artifact.')
    const record: UpdateRecord = {
      id: randomUUID(), manifest,
      journal: createUpdate({ current: this.identity.version, next: manifest.version, artifact, sha256: manifest.sha256 }),
    }
    await mkdir(this.directory(record), { recursive: true, mode: 0o700 })
    try {
      await durableCopy(path, this.artifact(record))
      await this.verify(record)
      if (this.identity.platform === 'linux' && this.identity.appImage !== undefined) {
        const target = resolve(this.identity.appImage)
        let writable = true
        try { await access(dirname(target), constants.W_OK) }
        catch (error) {
          if (!['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          writable = false
        }
        if (writable) record.portable = { target, sha256: await artifactSha256(target) }
      }
      return record
    } catch (error) {
      await rm(this.directory(record), { recursive: true, force: true })
      throw error
    }
  }

  /**
   * Read and replay the complete journal before accepting any recovery paths.
   * @returns verified recovery metadata, or undefined when no journal exists.
   */
  async read(): Promise<UpdateRecord | undefined> {
    let value: unknown
    try { value = await readJson(join(this.identity.directory, 'update.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (typeof value !== 'object' || value === null) throw new Error('Invalid update recovery record.')
    const input = value as Partial<Omit<UpdateRecord, 'portable'>> & { portable?: unknown }
    if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Invalid update recovery identity.')
    const journal = parseUpdateJournal(input.journal)
    const manifest = parseReleaseManifest(
      input.manifest, { ...this.identity, version: journal.candidate.current }, journal.candidate.artifact,
    )
    if (manifest.version !== journal.candidate.next || manifest.sha256 !== journal.candidate.sha256) {
      throw new Error('Update recovery metadata disagrees with the journal.')
    }
    let portable: UpdateRecord['portable']
    if (input.portable !== undefined) {
      const candidate = input.portable
      if (candidate === null || typeof candidate !== 'object' || this.identity.platform !== 'linux'
        || !('target' in candidate) || typeof candidate.target !== 'string' || !isAbsolute(candidate.target)
        || !('sha256' in candidate)
        || typeof candidate.sha256 !== 'string' || !digestPattern.test(candidate.sha256)) throw new Error('Invalid portable recovery metadata.')
      portable = { target: candidate.target, sha256: candidate.sha256 }
      if (['installing', 'verifying', 'handoff', 'rollback-required'].includes(journal.state)) {
        if (this.identity.appImage === undefined) throw new Error('Portable recovery requires the running AppImage path.')
        const running = resolve(this.identity.appImage)
        const retained = `${portable.target}.harniverse-previous-${input.id}.AppImage`
        if (running !== portable.target && (running !== retained || await artifactSha256(running) !== portable.sha256)) {
          throw new Error('Portable recovery is only available at the original AppImage path or its verified retained executable.')
        }
      }
    }
    return { id: input.id, manifest, journal, ...(portable === undefined ? {} : { portable }) }
  }

  /**
   * Flush the file before atomic replacement, then flush the parent directory on POSIX.
   * @param record - the next transaction checkpoint.
   */
  async write(record: UpdateRecord): Promise<void> {
    await mkdir(this.identity.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.identity.directory, `.journal-${randomUUID()}`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync() }
    finally { await file.close() }
    try {
      await rename(temporary, join(this.identity.directory, 'update.json'))
      await syncDirectory(this.identity.directory)
    } finally { await rm(temporary, { force: true }) }
  }

  /**
   * Resolve the private staged artifact; native APIs never receive a renderer-supplied path.
   * @param record - validated transaction metadata.
   * @returns the artifact's private absolute location.
   */
  artifact(record: UpdateRecord): string { return join(this.directory(record), record.manifest.artifact) }

  private directory(record: UpdateRecord): string { return join(this.identity.directory, record.id) }

  /**
   * Recheck the exact staged bytes at each native install or launch boundary.
   * @param record - validated transaction metadata.
   */
  async verify(record: UpdateRecord): Promise<void> {
    if (await artifactSha256(this.artifact(record)) !== record.manifest.sha256) throw new Error('The selected artifact SHA-256 does not match its release manifest.')
  }

  /**
   * Replace only a writable AppImage, after preserving and verifying its previous bytes.
   * @param record - consented transaction whose owned Host has cleanly exited.
   */
  async install(record: UpdateRecord): Promise<void> {
    await this.verify(record)
    if (record.portable === undefined) return
    const { target, sha256 } = record.portable
    if (await artifactSha256(target) !== sha256) throw new Error('The current AppImage changed after consent; update cancelled.')
    const previous = this.previous(record)
    await durableCopy(target, previous)
    if (await artifactSha256(previous) !== sha256) throw new Error('The previous AppImage could not be verified.')
    const temporary = `${target}.harniverse-next-${record.id}`
    try {
      await durableCopy(this.artifact(record), temporary)
      if (await artifactSha256(temporary) !== record.manifest.sha256) throw new Error('The staged AppImage changed before installation.')
      await rename(temporary, target)
      await syncDirectory(dirname(target))
    } finally { await rm(temporary, { force: true }) }
  }

  /**
   * Restore verified previous bytes only over this transaction's candidate, never over a foreign replacement.
   * @param record - failed portable transaction with retained executable metadata.
   */
  async rollback(record: UpdateRecord): Promise<void> {
    if (record.portable === undefined) return
    const { target, sha256 } = record.portable
    let current: string | undefined
    try { current = await artifactSha256(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (current === sha256) return
    if (current !== undefined && current !== record.manifest.sha256) throw new Error('The AppImage changed outside this update. Its retained previous version requires manual recovery.')
    const previous = this.previous(record)
    if (await artifactSha256(previous) !== sha256) throw new Error('The retained AppImage failed verification; automatic restoration is refused.')
    const temporary = `${target}.harniverse-restore-${randomUUID()}`
    try {
      await durableCopy(previous, temporary)
      if (await artifactSha256(temporary) !== sha256) throw new Error('The restored AppImage failed verification.')
      await rename(temporary, target)
      await syncDirectory(dirname(target))
    } finally { await rm(temporary, { force: true }) }
  }

  private previous(record: UpdateRecord): string {
    if (record.portable === undefined) throw new Error('No previous portable executable belongs to this update.')
    return `${record.portable.target}.harniverse-previous-${record.id}.AppImage`
  }
}
