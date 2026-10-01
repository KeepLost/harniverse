/** Bounded, versioned AES-GCM credential documents; the provider sanitizes parsing failures. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** Maximum encoded credential document size accepted from disk. */
export const MAX_FILE_BYTES = 1_500_000
const MAX_SNAPSHOT_BYTES = 1_048_576
const MAX_VALUES = 1024
const MAX_REF_BYTES = 128
const MAX_VALUE_BYTES = 65_536
const AAD = Buffer.from('@deepseek-ai/dsh-credentials-encrypted:1', 'utf8')

/**
 * Decode exactly 32 random bytes in canonical, unpadded base64url form.
 * @param value - runtime-supplied key encoding.
 * @returns owned key bytes; the caller must overwrite them on every terminal path.
 */
export function decodeKey(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('credentials-encrypted: expected a 32-byte key in canonical base64url')
  }
  const key = Buffer.from(value, 'base64url')
  if (key.toString('base64url') !== value) {
    key.fill(0)
    throw new Error('credentials-encrypted: expected a 32-byte key in canonical base64url')
  }
  return key
}

/**
 * Copy and validate a complete snapshot without invoking caller-owned accessors.
 * @param value - parsed or runtime-supplied credential record.
 * @returns the validated, independently owned map.
 */
export function snapshot(value: unknown): Map<string, string> {
  const invalid = () => new Error('credentials-encrypted: invalid or oversized credential snapshot')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) throw invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_VALUES) throw invalid()
  const result = new Map<string, string>()
  let bytes = 2
  for (const ref of keys) {
    if (typeof ref !== 'string' || ref.length > MAX_REF_BYTES || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, ref)
    const secret: unknown = descriptor?.value
    if (!descriptor?.enumerable || typeof secret !== 'string' || !secret.length
      || Buffer.byteLength(secret) > MAX_VALUE_BYTES) throw invalid()
    bytes += Buffer.byteLength(JSON.stringify(ref)) + Buffer.byteLength(JSON.stringify(secret)) + 1
      + (result.size ? 1 : 0)
    if (bytes > MAX_SNAPSHOT_BYTES) throw invalid()
    result.set(ref, secret)
  }
  return result
}

/**
 * Encrypt the complete JSON payload with a fresh 96-bit IV and a 128-bit tag.
 * @param values - validated snapshot.
 * @param key - active 32-byte encryption key, borrowed only during this call.
 * @returns a bounded version-1 envelope containing ciphertext only.
 */
export function encrypt(values: Map<string, string>, key: Buffer): string {
  const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(values)), 'utf8')
  try {
    if (plaintext.length > MAX_SNAPSHOT_BYTES) throw new Error('credentials-encrypted: oversized credential snapshot')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const document = JSON.stringify({
      version: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }) + '\n'
    /* v8 ignore next -- MAX_SNAPSHOT_BYTES plus the envelope encoding is below MAX_FILE_BYTES by construction. */
    if (Buffer.byteLength(document) > MAX_FILE_BYTES) throw new Error('credentials-encrypted: oversized encrypted document')
    return document
  } finally {
    plaintext.fill(0)
  }
}

function decodeField(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid envelope')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('invalid envelope')
  }
  return bytes
}

/**
 * Authenticate before parsing any decrypted bytes, and erase all plaintext buffers on exit.
 * @param document - bounded encrypted envelope from private storage.
 * @param key - candidate 32-byte encryption key.
 * @returns authenticated, validated values; callers sanitize parsing and authentication failures.
 */
export function decrypt(document: string, key: Buffer): Map<string, string> {
  const value: unknown = JSON.parse(document)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid envelope')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).length !== 4 || fields.version !== 1) throw new Error('invalid envelope')
  const iv = decodeField(fields.iv, 12)
  const tag = decodeField(fields.tag, 16)
  const ciphertext = decodeField(fields.ciphertext)
  if (ciphertext.length > MAX_SNAPSHOT_BYTES) throw new Error('invalid envelope')
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  const partial = decipher.update(ciphertext)
  let final: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    final = decipher.final()
    plaintext = Buffer.concat([partial, final])
    return snapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)))
  } finally {
    partial.fill(0)
    final?.fill(0)
    plaintext?.fill(0)
  }
}
