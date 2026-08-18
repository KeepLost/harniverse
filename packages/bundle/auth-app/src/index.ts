/** One-shot authentication management runner. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  approveEnrollmentRequest,
  createAuthenticationClientGrant,
  listAuthenticationGrants,
  listEnrollmentRequests,
  revokeAuthenticationGrant,
} from '@deepseek-ai/dsh-authentication-local'
import {
  authenticationGrantId,
  isAuthenticationCapability,
  type AuthenticationCapability,
} from '@deepseek-ai/dsh-authentication'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { AuthOperation } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-runner'

/** Parsed app invocation required before management starts. */
export const inject = ['authStartup']

/** Authentication management runner configuration. */
export interface Config {
  /** Selected Grant operation. */
  operation: AuthOperation
  /** Enrollment id, Grant id, or client name. */
  name?: string
  /** Base64url P-256 SPKI key for client registration. */
  publicKey?: string
  /** Convenience capability profile. */
  profile?: string
  /** Explicit automation capabilities. */
  capabilities?: string[]
  /** Harness home containing the local Grant registry. */
  dshHome?: string
}

/** Loader validation for the runner row. */
export const Config: z<Config> = z.object({
  operation: z.union([
    z.const('device-list'), z.const('device-approve'), z.const('device-revoke'),
    z.const('grant-list'), z.const('grant-revoke'), z.const('client-add'), z.const('client-revoke'),
  ]).required(),
  name: z.string(),
  publicKey: z.string(),
  profile: z.string(),
  capabilities: z.array(z.string()),
  dshHome: z.string(),
})

interface TextOutput {
  write(value: string): unknown
}

/** Process streams used by the runner; tests replace them with captures. */
export const internals: { stdout: TextOutput; stderr: TextOutput } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function profileCapabilities(profile: string): AuthenticationCapability[] {
  switch (profile) {
    case 'observer': return ['harniverse.observe']
    case 'operator': return ['harniverse.observe', 'harniverse.operate']
    case 'administrator': return ['harniverse.observe', 'harniverse.operate', 'harniverse.administer']
    case 'owner': return ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize']
    case 'temporary': return ['harniverse.observe', 'harniverse.operate']
    default: throw new Error(`auth-runner: unknown capability profile "${profile}"`)
  }
}

function explicitCapabilities(values: readonly string[]): AuthenticationCapability[] {
  if (values.length === 0 || values.some(value => !isAuthenticationCapability(value))) {
    throw new Error('auth-runner: --capability values must be supported harniverse.* capabilities')
  }
  return [...new Set(values as AuthenticationCapability[])]
}

function required(value: string | undefined, operation: AuthOperation, field: string): string {
  if (value === undefined) throw new Error(`auth-runner: ${operation} requires ${field}`)
  return value
}

/** Execute one operation and request bounded process exit. */
async function run(config: Config, exit: (code: number) => void): Promise<void> {
  const options = config.dshHome === undefined ? {} : { dshHome: config.dshHome }
  switch (config.operation) {
    case 'device-list': {
      const requests = await listEnrollmentRequests(options)
      for (const request of requests) {
        internals.stdout.write(`${request.id}\t${request.approvalCode}\t${request.name}\t${request.kind}\t${request.expiresAt}\n`)
      }
      break
    }
    case 'device-approve': {
      const profile = required(config.profile, config.operation, 'a profile')
      const grant = await approveEnrollmentRequest(required(config.name, config.operation, 'an enrollment id'), {
        capabilities: profileCapabilities(profile),
        ...(profile === 'temporary' && { expiresInMs: 60 * 60_000, idleTimeoutMs: 15 * 60_000 }),
      }, options)
      internals.stdout.write(`${grant.id}\n`)
      break
    }
    case 'device-revoke':
    case 'grant-revoke':
    case 'client-revoke':
      await revokeAuthenticationGrant(authenticationGrantId(required(config.name, config.operation, 'a Grant id')), options)
      break
    case 'grant-list': {
      const grants = await listAuthenticationGrants(options)
      for (const grant of grants) {
        internals.stdout.write(`${grant.id}\t${grant.name}\t${grant.kind}\t${grant.capabilities.join(',')}\t${grant.expiresAt ?? '-'}\n`)
      }
      break
    }
    case 'client-add': {
      const name = required(config.name, config.operation, 'a client name')
      const publicKey = required(config.publicKey, config.operation, 'a public key')
      const capabilities = config.profile !== undefined
        ? profileCapabilities(config.profile)
        : explicitCapabilities(config.capabilities ?? [])
      const grant = await createAuthenticationClientGrant({
        name,
        publicKey,
        capabilities,
      }, options)
      internals.stdout.write(`${grant.id}\n`)
      break
    }
    /* v8 ignore next 2 -- Loader validation and the closed AuthOperation union exclude another operation */
    default:
      config.operation satisfies never
  }
  exit(0)
}

/**
 * Mount the one-shot management runner.
 * @param ctx - plugin context carrying the launcher's exit request.
 * @param config - selected management operation and Harness home.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('auth-runner: the launcher must provide ctx.appExit before the tree mounts')
  void run(config, exit).catch((error: unknown) => {
    let message: string
    /* v8 ignore else -- local management APIs reject Error instances */
    if (error instanceof Error) message = error.message
    else message = String(error)
    internals.stderr.write(`dsh: ${message}\n`)
    exit(1)
  })
}
