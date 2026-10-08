/**
 * One-time pairing codes. A code is ten Crockford base32 characters (50 bits)
 * drawn from the system CSPRNG; only its SHA-256 is stored, and redemption
 * deletes it, so a code works once and only until its expiry.
 * @module @deepseek-ai/dsh-chat-bridge/pairing
 */

import { createHash, randomBytes } from 'node:crypto'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CodeRecord } from './state.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Normalize user input to the canonical code form (Crockford: case-insensitive, `I`/`L` read as 1, `O` as 0, separators ignored).
 * @param input - text as typed by a person.
 * @returns the canonical uppercase code.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
}

/**
 * Hash a code for storage and lookup.
 * @param input - a code in any accepted spelling.
 * @returns lowercase hex SHA-256 of the canonical form.
 */
export function hashCode(input: string): string {
  return createHash('sha256').update(normalizeCode(input)).digest('hex')
}

/**
 * Draw a one-time code from 50 random bits.
 * @returns a fresh code formatted `XXXXX-XXXXX`.
 */
export function generateCode(): string {
  const bytes = randomBytes(10)
  let code = ''
  for (const byte of bytes) code += ALPHABET.charAt(byte & 31)
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

/**
 * Issue a code and persist its hash.
 * @param table - the `codes` table.
 * @param record - what redeeming the code grants, with its absolute expiry.
 * @returns the plaintext code, shown exactly once.
 */
export async function issueCode(table: KvTable<string, CodeRecord>, record: CodeRecord): Promise<string> {
  const code = generateCode()
  await table.put(hashCode(code), record)
  return code
}

/**
 * Redeem a code exactly once.
 * @param table - the `codes` table.
 * @param input - the code as typed.
 * @param now - current time in ms.
 * @returns the grant, or undefined for an unknown, used, or expired code; an expired code is removed.
 */
export async function redeemCode(table: KvTable<string, CodeRecord>, input: string, now: number): Promise<CodeRecord | undefined> {
  const hash = hashCode(input)
  const record = table.get(hash)
  if (record === undefined) return undefined
  if (!(await table.delete(hash))) return undefined
  return record.expiresAt > now ? record : undefined
}
