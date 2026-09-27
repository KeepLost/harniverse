import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { AuthSecrets, HostConfig, HostRecord, RemoteHostId } from './types.ts'

const text = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const ref = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
/** Schema for a persisted remote-host UUID. */
export const idSchema = z.uuid()
const port = z.number().int().min(1).max(65535)
/** Schema for secret-free persisted authentication references. */
export const authenticationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('password'), passwordRef: ref.optional() }),
  z.strictObject({ kind: z.literal('key'), privateKeyRef: ref.optional(), passphraseRef: ref.optional() }),
  z.strictObject({ kind: z.literal('agent'), socket: text }),
])
/** Schema for explicit one-shot login secrets. */
export const secretsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('password'), password: z.string().min(1).max(65536) }),
  z.strictObject({ kind: z.literal('key'), privateKey: z.string().min(1).max(65536), passphrase: z.string().min(1).max(65536).optional() }),
])
const mappingSchema = z.strictObject({
  localHost: text.refine(value => !/[\s/\\@]/.test(value)), localPort: port,
  remoteOriginalOrigin: z.string().refine((value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash
    } catch { return false } // Invalid user-entered origins are validation failures.
  }).transform(value => new URL(value).origin),
})
/** Schema for a complete persisted host configuration. */
export const hostSchema = z.strictObject({
  name: text, host: text.refine(value => !/[\s/\\@]/.test(value)), port: port.default(22), username: text,
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).refine(value =>
    Buffer.from(value.slice(7), 'base64').toString('base64').replace(/=+$/, '') === value.slice(7)),
  platform: z.enum(['linux', 'darwin', 'win32']), architecture: z.enum(['x64', 'arm64']),
  dshHome: text.optional(), authentication: authenticationSchema, reverseMappings: z.array(mappingSchema).max(64).default([]),
}).superRefine((host, ctx) => {
  if (host.dshHome !== undefined) {
    const paths = host.platform === 'win32' ? win32 : posix
    const normalized = paths.normalize(host.dshHome)
    if (!paths.isAbsolute(host.dshHome) || normalized === paths.parse(normalized).root) {
      ctx.addIssue({ code: 'custom', message: 'absolute non-root remote home required' })
    }
  }
  if (new Set(host.reverseMappings.map(mapping => mapping.remoteOriginalOrigin)).size !== host.reverseMappings.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate reverse origin' })
  }
})
/** Schema for host creation or replacement input. */
export const upsertSchema = hostSchema.safeExtend({
  id: idSchema.optional(), secrets: secretsSchema.optional(), storeCredentials: z.boolean().default(false),
})
/** Schema for host connection input. */
export const connectSchema = z.strictObject({
  id: idSchema, secrets: secretsSchema.optional(), storeCredentials: z.boolean().default(false),
})
/** Schema for unauthenticated host-key probe input. */
export const probeSchema = z.strictObject({ host: text, port: port.optional(), username: text })

/** Parse an untrusted UUID into the local branded identity.
 * @param value - untrusted UUID.
 * @returns stable branded registry identity.
 */
export function remoteHostId(value: string): RemoteHostId { return idSchema.parse(value) as RemoteHostId }
/** Parse untrusted host fields into a detached configuration.
 * @param value - untrusted host fields.
 * @returns validated nonsecret configuration.
 */
export function parseHostInput(value: unknown): HostConfig {
  // JSON detachment removes explicitly undefined optional fields after schema validation.
  return JSON.parse(JSON.stringify(hostSchema.parse(value))) as HostConfig
}
/** Parse one persisted host record.
 * @param value - persisted JSON value.
 * @returns validated detached host record.
 */
export function parseRecord(value: unknown): HostRecord {
  const parsed = hostSchema.safeExtend({ id: idSchema }).parse(value)
  return JSON.parse(JSON.stringify(parsed)) as HostRecord
}
/** Parse explicit login secrets into a detached value.
 * @param value - untrusted secret input.
 * @returns validated detached secrets.
 */
export function authSecrets(value: unknown): AuthSecrets {
  return JSON.parse(JSON.stringify(secretsSchema.parse(value))) as AuthSecrets
}

/** Fixed public failure; upstream messages must not cross this boundary. */
export class RemoteHostsError extends Error {
  constructor(readonly code: string) { super(`remote-hosts: ${code}`); this.name = 'RemoteHostsError' }
}
