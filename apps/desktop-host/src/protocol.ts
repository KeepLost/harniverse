/** Private parent/owned-child protocol. No renderer or network transport mounts these commands. */
import { createPublicKey } from 'node:crypto'
import { isAbsolute } from 'node:path'

export type HostCommand =
  | { type: 'shutdown' }
  | { type: 'enroll'; requestId: number; publicKey: string }
  | { type: 'activity'; requestId: number }
  | { type: 'update-tasks'; requestId: number; action: 'inspect' | 'lock' | 'unlock' }
  | { type: 'directory-result'; requestId: number; path: string | null }

export type HostActivity =
  | { status: 'unknown' }
  | { status: 'idle' | 'active'; sessions: number; tasks: number }

/** Parse complete IPC commands, rejecting unknown keys and noncanonical public keys. */
export function parseHostCommand(value: unknown): HostCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  const keys = (...allowed: string[]) => Object.keys(row).length === allowed.length && allowed.every(key => Object.hasOwn(row, key))
  if (row.type === 'shutdown' && keys('type')) return { type: 'shutdown' }
  if (!Number.isSafeInteger(row.requestId) || (row.requestId as number) < 0) return
  const requestId = row.requestId as number
  if (row.type === 'activity' && keys('type', 'requestId')) return { type: row.type, requestId }
  if (row.type === 'update-tasks' && keys('type', 'requestId', 'action')
    && (row.action === 'inspect' || row.action === 'lock' || row.action === 'unlock')) return { type: row.type, requestId, action: row.action }
  if (row.type === 'directory-result' && keys('type', 'requestId', 'path')
    && (row.path === null || (typeof row.path === 'string' && row.path.length <= 32768 && !row.path.includes('\0') && isAbsolute(row.path)))) {
    return { type: row.type, requestId, path: row.path }
  }
  if (row.type !== 'enroll' || !keys('type', 'requestId', 'publicKey') || typeof row.publicKey !== 'string'
    || row.publicKey.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(row.publicKey)) return
  try {
    const key = createPublicKey({ key: Buffer.from(row.publicKey, 'base64url'), type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== row.publicKey) return
    return { type: 'enroll', requestId, publicKey: row.publicKey }
  } catch {
    // Malformed DER is an invalid command, never a process-level error.
    return
  }
}

/** Inherited executable/credential overrides cannot enter the owned profile or its subprocesses. */
export function scrubHostEnvironment(environment: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || /KEY|SECRET|TOKEN|PASSWORD/iu.test(name)
      || /^(?:NODE_.+|CORDIS_.+|ELECTRON_.+|DSH_.+|HARNIVERSE_.+|LD_.+|DYLD_.+)$/iu.test(name)) continue
    result[name] = value
  }
  result.DSH_HOME = home
  return result
}
