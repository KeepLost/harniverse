/** An in-memory credential provider that can fail on demand. */

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

function matches(pattern: RegExp | string | undefined, ref: string): boolean {
  if (pattern === undefined) return false
  return typeof pattern === 'string' ? pattern === ref : pattern.test(ref)
}

/** Records every call so a test can assert what reached the store. */
export class MemoryCredentials {
  readonly values = new Map<string, string>()
  readonly calls: string[] = []
  /** Reject `set` for every reference this pattern matches. */
  failSet: RegExp | string | undefined
  /** Reject `unset` for every reference this pattern matches. */
  failUnset: RegExp | string | undefined

  resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: string): Promise<{ configured: boolean; writable: boolean }> {
    return Promise.resolve({ configured: this.values.has(ref), writable: true })
  }

  set(ref: string, value: string): Promise<void> {
    this.calls.push(`set ${ref}`)
    if (matches(this.failSet, ref)) return Promise.reject(new Error(`cannot store ${ref}`))
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: string): Promise<void> {
    this.calls.push(`unset ${ref}`)
    if (matches(this.failUnset, ref)) return Promise.reject(new Error(`cannot remove ${ref}`))
    this.values.delete(ref)
    return Promise.resolve()
  }

  /** @returns this store typed as the provider seam. */
  asProvider(): CredentialProvider {
    return this as unknown as CredentialProvider
  }
}
