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
export type PeerOperation = 'invite' | 'add' | 'list' | 'remove' | 'targets' | 'forget' | 'cancel' | 'run' | 'send' | 'sessions' | 'result' | 'surface' | 'fetch' | 'outbox'

/** Options the run command collects from its flags. */
interface RunOptions {
  cwd?: string
  profile?: string
  timeout: number
  async?: boolean
  attach?: string[]
}

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
  /** Instance id targeted by most operations. */
  instanceId?: string
  /** Complete desired surface for `surface`. */
  surface?: {
    /** Delegate grant requested by `surface`. */
    delegate: boolean
    /** Message grant requested by `surface`. */
    message: boolean
    /** List grant requested by `surface`. */
    list: boolean
    /** Artifact grant requested by `surface`. */
    artifacts: boolean
  }
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
  /** Submit without waiting for settlement, for `run` and `send`. */
  async?: boolean
  /** Message id of the watched turn for `result`. */
  messageId?: string
  /** Local file paths delivered with the prompt, for `run` and `send`. */
  attach?: string[]
  /** Workspace-relative path fetched from the peer root, for `fetch`. */
  path?: string
  /** Directory the fetched file lands in, for `fetch`. */
  out?: string
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
    .option('--async', 'submit and print the receipt without waiting for settlement')
    .option(
      '--attach <path>',
      'local file delivered with the prompt; repeat for each file',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action((instanceId: string, prompt: string[], options: RunOptions) => {
      publish('run', {
        instanceId,
        prompt: prompt.join(' '),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.profile !== undefined && { profile: options.profile }),
        timeoutMs: options.timeout,
        ...(options.async === true && { async: true }),
        ...(options.attach !== undefined && options.attach.length > 0 && { attach: options.attach }),
      })
    })
  program.command('send')
    .description('deliver the next turn into one delegated session')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<session-id>', 'delegated session id')
    .argument('<prompt...>', 'follow-up prompt words')
    .option('--timeout <ms>', 'settlement-wait budget in milliseconds', (value: string) => Number(value), 600000)
    .option('--async', 'submit and print the receipt without waiting for settlement')
    .option(
      '--attach <path>',
      'local file delivered with the prompt; repeat for each file',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action((instanceId: string, sessionId: string, prompt: string[], options: { timeout: number; async?: boolean; attach?: string[] }) => {
      publish('send', {
        instanceId, sessionId, prompt: prompt.join(' '), timeoutMs: options.timeout, ...(options.async === true && { async: true }),
        ...(options.attach !== undefined && options.attach.length > 0 && { attach: options.attach }),
      })
    })
  program.command('sessions')
    .description("list this instance's delegated sessions on a paired target")
    .argument('<instance-id>', 'paired target instance id')
    .action((instanceId: string) => { publish('sessions', { instanceId }) })
  program.command('cancel')
    .description('cancel the current turn of one delegated session')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<session-id>', 'delegated session id')
    .action((instanceId: string, sessionId: string) => {
      publish('cancel', { instanceId, sessionId })
    })
  program.command('result')
    .description('read one delegated turn\u2019s settlement without a new prompt')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<session-id>', 'delegated session id')
    .argument('<message-id>', 'accepted turn message id printed at submission')
    .action((instanceId: string, sessionId: string, messageId: string) => {
      publish('result', { instanceId, sessionId, messageId })
    })
  program.command('surface')
    .description('request a surface change on a paired target; pure narrowings commit immediately, widenings await owner approval')
    .argument('<instance-id>', 'paired target instance id')
    .requiredOption('--delegate <on|off>', 'delegate grant: on or off')
    .requiredOption('--message <on|off>', 'message grant: on or off')
    .requiredOption('--list <on|off>', 'list grant: on or off')
    .requiredOption('--artifacts <on|off>', 'artifact grant: on or off')
    .action((instanceId: string, options: { delegate: string; message: string; list: string; artifacts: string }) => {
      const flag = (value: string): boolean => {
        if (value !== 'on' && value !== 'off') program.error(`--delegate/--message/--list/--artifacts take "on" or "off", got "${value}"`)
        return value === 'on'
      }
      publish('surface', {
        instanceId,
        surface: {
          delegate: flag(options.delegate), message: flag(options.message), list: flag(options.list),
          artifacts: flag(options.artifacts),
        },
      })
    })
  program.command('fetch')
    .description('copy one bounded workspace file from the peer root on a paired target')
    .argument('<instance-id>', 'paired target instance id')
    .argument('<path>', 'file path relative to the peer root on the target')
    .option('--out <dir>', 'directory the fetched file lands in (default peer-downloads/<instance-id> under this home)')
    .action((instanceId: string, path: string, options: { out?: string }) => {
      publish('fetch', {
        instanceId, path, ...(options.out !== undefined && { out: options.out }),
      })
    })
  program.command('outbox')
    .description("list this home's initiator settlement ledger (written by a running instance)")
    .action(() => { publish('outbox') })
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
