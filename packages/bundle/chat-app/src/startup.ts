/** Chat bridge command-line provider: `dsh chat [run|init|status|rotate-key]`. */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'chat-startup'

/** Services required before the command can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided to the chat composition. */
export const CHAT_STARTUP_SERVICE = 'chatStartup'

/** What one `dsh chat` invocation does. */
export type ChatOperation = 'run' | 'init' | 'status' | 'rotate-key'

/** One parsed `dsh chat` invocation. */
export interface ChatStartupValues {
  /** Selected operation; a bare `dsh chat` runs the bridge. */
  operation: ChatOperation
  /** Harniverse origin `status` probes. */
  origin?: string
}

/**
 * Build this app's command tree.
 * @param ctx - plugin context that receives the selected invocation.
 * @returns a fresh command tree.
 */
function chatCommand(ctx: Context): Command {
  const program = new Command()
    .name('dsh chat')
    .description('Bridge IM platforms to a local Harniverse.')
    .helpOption('-h, --help', 'show this help')
  const publish = (values: ChatStartupValues): void => {
    ctx.provide(CHAT_STARTUP_SERVICE, values satisfies ChatStartupValues)
  }
  program.command('run').description('run the bridge until stopped (the default)').action(() => { publish({ operation: 'run' }) })
  program.command('init').description('create the signing key, register the Grant, write a config template, and print an owner pairing code')
    .action(() => { publish({ operation: 'init' }) })
  program.command('status').description('show the key, Grant, Harniverse reachability, and stored state (read only)')
    .option('--origin <url>', 'Harniverse origin to probe', 'http://127.0.0.1:3080')
    .action((options: { origin: string }) => { publish({ operation: 'status', origin: options.origin }) })
  program.command('rotate-key').description('replace the signing key and Grant, then revoke the old Grant')
    .action(() => { publish({ operation: 'rotate-key' }) })
  // A bare `dsh chat` runs. cordis.patch.yml mounts the run-only rows for
  // exactly `[]` and `['run']`; keep that `disabled` expression in step with this.
  program.action(() => { publish({ operation: 'run' }) })
  return program
}

/**
 * Parse the chat command and provide its selected operation.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, chatCommand(ctx))
}
