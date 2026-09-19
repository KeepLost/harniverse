/** Authentication management command-line provider. */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'auth-startup'

/** Services required before the command can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided to the authentication management runner. */
export const AUTH_STARTUP_SERVICE = 'authStartup'

/** Supported Grant management operations. */
export type AuthOperation =
  | 'device-list'
  | 'device-approve'
  | 'device-revoke'
  | 'grant-list'
  | 'grant-revoke'
  | 'client-add'
  | 'client-revoke'
  | 'code-issue'
  | 'code-list'
  | 'code-revoke'

/** One parsed authentication management invocation. */
export interface AuthStartupValues {
  /** Selected Grant-management operation. */
  operation: AuthOperation
  /** Enrollment id, Grant id, or client name targeted by the operation. */
  name?: string
  /** P-256 SPKI public key for a new API client. */
  publicKey?: string
  /** Convenience capability profile. */
  profile?: string
  /** Explicit capability list for automation clients. */
  capabilities?: string[]
  /** Invitation target kind: `device` (default) or `temporary`. */
  kind?: string
  /** Optional device-name binding required at invitation redemption. */
  bindName?: string
  /** Invitation lifetime, such as `30m`, `12h`, or `7d`. */
  ttl?: string
  /** Invitation batch size for one issuance invocation. */
  count?: number
}

/**
 * Build this app's command tree.
 * @param ctx - plugin context that receives the selected invocation.
 * @returns a fresh command tree.
 */
function authCommand(ctx: Context): Command {
  const program = new Command()
    .name('dsh auth')
    .description('Manage inbound authentication.')
    .helpOption('-h, --help', 'show this help')
  const publish = (operation: AuthOperation, values: Omit<AuthStartupValues, 'operation'> = {}): void => {
    ctx.provide(AUTH_STARTUP_SERVICE, {
      operation,
      ...values,
    } satisfies AuthStartupValues)
  }
  const device = program.command('device').description('approve and revoke browser devices')
  device.command('list').description('list pending device requests').action(() => { publish('device-list') })
  device.command('approve')
    .description('approve a pending device request')
    .argument('<request-id>')
    .requiredOption('--profile <profile>', 'observer, operator, administrator, owner, or temporary')
    .action((requestId: string, options: { profile: string }) => {
      publish('device-approve', { name: requestId, profile: options.profile })
    })
  device.command('revoke').description('revoke a browser Grant').argument('<grant-id>')
    .action((grantId: string) => { publish('device-revoke', { name: grantId }) })

  const grant = program.command('grant').description('inspect and revoke all Grants')
  grant.command('list').description('list approved Grants').action(() => { publish('grant-list') })
  grant.command('revoke').description('revoke one Grant').argument('<grant-id>')
    .action((grantId: string) => { publish('grant-revoke', { name: grantId }) })

  const client = program.command('client').description('register automation public keys')
  client.command('add')
    .description('register one API client public key')
    .argument('<name>')
    .requiredOption('--public-key <spki>', 'base64url DER SubjectPublicKeyInfo')
    .option('--profile <profile>', 'observer, operator, administrator, or owner')
    .option('--capability <capabilities...>', 'explicit harniverse.* capabilities')
    .action((clientName: string, options: { publicKey: string; profile?: string; capability?: string[] }) => {
      if ((options.profile === undefined) === (options.capability === undefined)) {
        throw new Error('client add requires exactly one of --profile or --capability')
      }
      publish('client-add', {
        name: clientName,
        publicKey: options.publicKey,
        ...(options.profile !== undefined && { profile: options.profile }),
        ...(options.capability !== undefined && { capabilities: options.capability }),
      })
    })
  client.command('revoke').description('revoke one API client Grant').argument('<grant-id>')
    .action((grantId: string) => { publish('client-revoke', { name: grantId }) })

  const code = program.command('code').description('manage pre-issued enrollment invitations')
  code.command('issue')
    .description('issue one-time enrollment invitations')
    .option('--ttl <duration>', '30s, 5m, 12h, 7d, or milliseconds')
    .option('--profile <profile>', 'observer, operator, administrator, or owner')
    .option('--capability <capabilities...>', 'explicit harniverse.* capabilities')
    .option('--kind <kind>', 'device (default) or temporary')
    .option('--bind <name>', 'require this device name at redemption')
    .option('--count <count>', 'issue several invitations', value => Number(value), 1)
    .action((options: { ttl?: string; profile?: string; capability?: string[]; kind?: string; bind?: string; count: number }) => {
      if (options.ttl === undefined) throw new Error('code issue requires --ttl')
      if ((options.profile === undefined) === (options.capability === undefined)) {
        throw new Error('code issue requires exactly one of --profile or --capability')
      }
      publish('code-issue', {
        ttl: options.ttl,
        count: options.count,
        ...(options.profile !== undefined && { profile: options.profile }),
        ...(options.capability !== undefined && { capabilities: options.capability }),
        ...(options.kind !== undefined && { kind: options.kind }),
        ...(options.bind !== undefined && { bindName: options.bind }),
      })
    })
  code.command('list').description('list retained invitations').action(() => { publish('code-list') })
  code.command('revoke').description('revoke one invitation').argument('<code-id>')
    .action((codeId: string) => { publish('code-revoke', { name: codeId }) })
  program.action(() => { program.help() })
  return program
}

/**
 * Parse the authentication command and provide its selected operation.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, authCommand(ctx))
}
