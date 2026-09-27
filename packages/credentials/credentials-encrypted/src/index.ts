/**
 * Encrypted remote CredentialProvider. The authenticated coordinator owns runtime unlock
 * and complete snapshot replacement; ordinary credential consumers remain read-only.
 * @module @deepseek-ai/dsh-credentials-encrypted
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { timingSafeEqual } from 'node:crypto'
import { join, resolve } from 'node:path'
import { decodeKey, decrypt, encrypt, snapshot } from './format.ts'
import { readDocument, UncertainCommitError, writeDocument } from './storage.ts'

/** Default encrypted document basename under the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.encrypted.json'

/** Non-secret plugin configuration; keys are accepted only by the runtime unlock method. */
export interface Config {
  /** Explicit encrypted document path, overriding dshHome. */
  path?: string
  /** Harness home; defaults to the home-paths service convention. */
  dshHome?: string
}

/** Runtime controls for the same instance registered as ctx.credentials. Authorize calls before dispatch. */
export interface EncryptedCredentialControl {
  /** @param key - 32 random bytes encoded as canonical unpadded base64url. */
  unlock(key: string): Promise<void>
  /** @param values - complete locally authoritative snapshot; omitted references are deleted. */
  replace(values: Record<string, string>): Promise<void>
  /** @returns availability only; no credential metadata or key material. */
  status(): { locked: boolean }
  /** Erase owned key bytes immediately and await outstanding file operations. */
  lock(): Promise<void>
}

interface Session {
  key: Buffer
  values?: Map<string, string>
}

/** A locked-at-boot service with one serialized queue for unlock and durable replacement. */
export class EncryptedCredentialProvider extends CredentialProvider implements EncryptedCredentialControl {
  static Config: z<Config> = z.object({ path: z.string(), dshHome: z.string() })

  private readonly filename: string
  private session: Session | undefined
  private operations: Promise<void> = Promise.resolve()
  private pending = 0
  private generation = 0
  private closed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    for (const value of [config.path, config.dshHome]) {
      if (value !== undefined && (typeof value !== 'string' || !value.length || value.includes('\0'))) {
        throw new Error('credentials-encrypted: invalid storage path configuration')
      }
    }
    this.filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME))
  }

  *[Service.init](): Generator<() => Promise<void>, void, void> {
    yield async () => {
      this.closed = true
      await this.lock()
    }
  }

  /** @returns availability without waiting for unlock, storage, or model configuration. */
  status(): { locked: boolean } {
    return { locked: this.session?.values === undefined }
  }

  /**
   * Authenticate and load the encrypted file; a missing file starts empty until replace commits.
   * Repeating the active key is a no-op. Changing it requires lock first; wrong keys preserve the active session.
   * @param key - canonical unpadded base64url encoding of 32 random bytes supplied over the authorized channel.
   */
  async unlock(key: string): Promise<void> {
    this.assertOpen()
    await this.enqueue(async () => {
      const candidate = decodeKey(key)
      let keep = false
      try {
        if (this.session?.values !== undefined) {
          if (!timingSafeEqual(candidate, this.session.key)) throw new Error('credentials-encrypted: unlock failed')
          return
        }
        const session: Session = { key: candidate }
        this.session = session
        let values: Map<string, string>
        try {
          const document = await readDocument(this.filename)
          if (this.session !== session) throw new Error('unlock cancelled')
          values = document === undefined ? new Map<string, string>() : decrypt(document, candidate)
        } catch {
          if (this.session === session) this.session = undefined
          throw new Error('credentials-encrypted: unlock failed')
        }
        session.values = values
        keep = true
      } finally {
        if (!keep) candidate.fill(0)
      }
    })
  }

  /**
   * Commit an exact snapshot before publishing values and changed-reference events, including deletions.
   * Failures before rename preserve the previous snapshot. Uncertain durability locks the provider.
   * Only the authenticated coordinator may expose this method to the local authority.
   * @param values - non-empty string values indexed by credential reference; an empty record deletes everything.
   */
  async replace(values: Record<string, string>): Promise<void> {
    this.active()
    const next = snapshot(values)
    try {
      await this.enqueue(async () => {
        const session = this.active()
        const previous = session.values
        const document = encrypt(next, session.key)
        try {
          await writeDocument(this.filename, document)
        } catch (error) {
          if (error instanceof UncertainCommitError) this.erase()
          throw error
        }
        // A lock or disposal may overlap a rename already in progress; it must never republish secrets.
        if (this.session !== session) return
        const changed = [...new Set([...previous.keys(), ...next.keys()])]
          .filter(ref => previous.get(ref) !== next.get(ref))
        session.values = next
        previous.clear()
        let invariantFailure: unknown
        for (const ref of changed) {
          if (this.session !== session) break
          try {
            this.notifyUpdated(credentialRef(ref))
          } catch (error) {
            // The base dispatcher contains observer failures; invariant failures follow complete fan-out.
            invariantFailure ??= error
          }
        }
        if (invariantFailure !== undefined) throw invariantFailure as Error
      })
    } finally {
      if (this.session?.values !== next) next.clear()
    }
  }

  /**
   * Erase owned key bytes and values immediately, invalidate queued work, then drain file operations.
   * An already-started encrypted rename may finish; no values or events publish after locking.
   */
  async lock(): Promise<void> {
    this.erase()
    await this.operations
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return new Promise((resolveValue) => {
      const value = this.active().values.get(ref)
      resolveValue(value === undefined ? undefined : { value, source: 'encrypted' })
    })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.session?.values?.has(ref) ?? false
    return Promise.resolve(configured ? { configured, source: 'encrypted', writable: false } : { configured, writable: false })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return this.rejectWrite()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return this.rejectWrite()
  }

  private rejectWrite(): Promise<never> {
    return Promise.reject(new Error(this.closed ? 'credentials-encrypted: provider is disposed'
      : 'credentials-encrypted: credentials are managed by the local authority; remote writes are denied'))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('credentials-encrypted: provider is disposed')
  }

  private active(): Session & { values: Map<string, string> } {
    this.assertOpen()
    if (!this.session?.values) throw new Error('credentials-encrypted: provider is locked; reconnect and unlock')
    return this.session as Session & { values: Map<string, string> }
  }

  private erase(): void {
    this.generation += 1
    this.session?.key.fill(0)
    this.session?.values?.clear()
    this.session = undefined
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.pending >= 16) throw new Error('credentials-encrypted: provider is busy; retry after pending operations finish')
    this.pending += 1
    const generation = this.generation
    const task = this.operations.then(async () => {
      this.assertOpen()
      if (generation !== this.generation) throw new Error('credentials-encrypted: provider was locked before operation ran')
      await operation()
    })
    const settled = () => { this.pending -= 1 }
    this.operations = task.then(settled, settled)
    return task
  }
}

export default EncryptedCredentialProvider
