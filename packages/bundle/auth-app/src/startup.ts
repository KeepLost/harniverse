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

/** Supported named-token management operations. */
export type AuthOperation = 'add' | 'reset' | 'delete' | 'list'

/** One parsed authentication management invocation. */
export interface AuthStartupValues {
  /** Operation selected below `token`. */
  operation: AuthOperation
  /** Token name for operations that target one token. */
  name?: string
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
  const token = program.command('token').description('manage named access tokens')
  const publish = (operation: AuthOperation, tokenName?: string): void => {
    ctx.provide(AUTH_STARTUP_SERVICE, {
      operation,
      ...(tokenName !== undefined && { name: tokenName }),
    } satisfies AuthStartupValues)
  }
  token.command('add').description('create a named token').argument('<name>').action((tokenName: string) => { publish('add', tokenName) })
  token.command('reset').description('replace a named token').argument('<name>').action((tokenName: string) => { publish('reset', tokenName) })
  token.command('delete').description('delete a named token').argument('<name>').action((tokenName: string) => { publish('delete', tokenName) })
  token.command('list').description('list token metadata').action(() => { publish('list') })
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
