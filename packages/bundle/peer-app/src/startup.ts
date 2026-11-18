/** Peer pairing management command-line provider. */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'peer-startup'

/** Services required before the command can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided to the peer pairing runner. */
export const PEER_STARTUP_SERVICE = 'peerStartup'

/** Supported peer pairing operations. */
export type PeerOperation = 'invite' | 'add' | 'list' | 'remove' | 'targets' | 'forget' | 'run' | 'send' | 'sessions'

/** One parsed peer pairing invocation. */
export interface PeerStartupValues {
  /** Selected pairing operation. */
  operation: PeerOperation
  /** Pasted `dsh-peer:` invitation URI for `add`. */
  uri?: string
  /** Target origin advertised in the invitation for `invite`. */
  endpoint?: string
  /** Display name for the invitation or this instance. */
  displayName?: string
  /** Invitation lifetime, such as `30s`, `10m`, or `7d`. */
  ttl?: string
  /** SHA-256 TLS certificate fingerprint, base64, for HTTPS endpoints. */
  fingerprint?: string
  /** remote-hosts record name dialed for a tunneled `add`. */
  sshHost?: string
  /** Instance id targeted by `remove` or `forget`. */
  instanceId?: string
  /** Per-request timeout in milliseconds for `add`. */
  timeoutMs?: number
  /** Delegation prompt words for `run` and `send`. */
  prompt?: string
  /** Session id targeted by `send`. */
  sessionId?: string
  /** Working directory relative to the peer root for `run`. */
  cwd?: string
  /** Agent profile id for `run`. */
  profile?: string
}

/**
 * Build this app's command tree.
 * @param ctx - plugin context that receives the selected invocation.
 * @returns a fresh command tree.
 */
function peerCommand(ctx: Context): Command {
  const program = new Command()
    .name('dsh peer')
    .description('Manage instance pairing.')
    .helpOption('-h, --help', 'show this help')
  const publish = (operation: PeerOperation, values: Omit<PeerStartupValues, 'operation'> = {}): void => {
    ctx.provide(PEER_STARTUP_SERVICE, { operation, ...values } satisfies PeerStartupValues)
  }
  program.command('invite')
    .description('issue one one-time pairing invitation for this instance')
    .requiredOption('--endpoint <origin>', 'origin initiators dial, such as https://host:8443 or http://127.0.0.1:42001')
    .option('--name <display>', 'display name advertised in the invitation')
    .option('--ttl <duration>', '10s, 5m, 1h, 7d, or milliseconds', '10m')
    .option('--fingerprint <base64>', 'SHA-256 TLS certificate fingerprint for HTTPS endpoints')
    .action((options: { endpoint: string; name?: string; ttl: string; fingerprint?: string }) => {
      publish('invite', {
        endpoint: options.endpoint,
        ...(options.name !== undefined && { displayName: options.name }),
        ttl: options.ttl,
        ...(options.fingerprint !== undefined && { fingerprint: options.fingerprint }),
      })
    })
  program.command('add')
    .description('pair this instance with a target using its invitation')
    .argument('<uri>', 'the pasted dsh-peer:// invitation')
    .option('--ssh-host <name>', 'dial through one remote-hosts record instead of the endpoint origin')
    .option('--timeout <ms>', 'per-request timeout in milliseconds', (value: string) => Number(value), 30000)
    .action((uri: string, options: { sshHost?: string; timeout: number }) => {
      publish('add', {
        uri,
        ...(options.sshHost !== undefined && { sshHost: options.sshHost }),
        timeoutMs: options.timeout,
      })
    })
  program.command('list')
    .description('list peers paired with this instance')
    .action(() => { publish('list') })
  program.command('remove')
    .description('remove one paired peer and revoke its Grant')
    .argument('<instance-id>')
    .action((instanceId: string) => { publish('remove', { instanceId }) })
  program.command('targets')
    .description('list pairing targets this instance initiated')
    .action(() => { publish('targets') })
  program.command('forget')
    .description('forget one pairing target record')
    .argument('<instance-id>')
    .action((instanceId: string) => { publish('forget', { instanceId }) })
  program.command('run')
    .description('start one delegated session on a paired target and await its reply')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<prompt...>', 'initial prompt words')
    .option('--cwd <path>', 'working directory relative to the peer root')
    .option('--profile <id>', 'agent profile id to compose the session with')
    .option('--timeout <ms>', 'settlement-wait budget in milliseconds', (value: string) => Number(value), 600000)
    .action((instanceId: string, prompt: string[], options: { cwd?: string; profile?: string; timeout: number }) => {
      publish('run', {
        instanceId,
        prompt: prompt.join(' '),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.profile !== undefined && { profile: options.profile }),
        timeoutMs: options.timeout,
      })
    })
  program.command('send')
    .description('deliver the next turn into one delegated session')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<session-id>', 'delegated session id')
    .argument('<prompt...>', 'follow-up prompt words')
    .option('--timeout <ms>', 'settlement-wait budget in milliseconds', (value: string) => Number(value), 600000)
    .action((instanceId: string, sessionId: string, prompt: string[], options: { timeout: number }) => {
      publish('send', { instanceId, sessionId, prompt: prompt.join(' '), timeoutMs: options.timeout })
    })
  program.command('sessions')
    .description("list this instance's delegated sessions on a paired target")
    .argument('<instance-id>', 'paired target instance id')
    .action((instanceId: string) => { publish('sessions', { instanceId }) })
  program.action(() => { program.help() })
  return program
}

/**
 * Parse the peer command and provide its selected operation.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, peerCommand(ctx))
}
