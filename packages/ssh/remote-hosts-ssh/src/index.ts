/** Plugin-native provider for pinned SSH connections to independent remote hosts. */
import { Service, type Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { ConnectConfig } from 'ssh2'
import { SshTransport } from './connection.ts'
import { RemoteHostSshError, isRecord, validPort, validText } from './errors.ts'
import type { Config, RemoteHostSshAuthentication, RemoteHostSshConfig, RemoteHostSshConnection, RemoteHostSshProvider, RemoteHostSshTarget } from './types.ts'

export type * from './types.ts'
export { RemoteHostSshError } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { remoteHostSsh: RemoteHostSshProvider }
}

const defaults: Required<Config> = {
  connectTimeoutMs: 30_000, operationTimeoutMs: 120_000,
  maxOutputBytes: 8 * 1024 * 1024, maxReadBytes: 4 * 1024 * 1024,
}

function validateTarget(config: unknown): asserts config is RemoteHostSshTarget {
  if (!isRecord(config) || !validText(config.host) || !validText(config.username) || !validPort(config.port ?? 22)) {
    throw new RemoteHostSshError('INVALID_CONFIG')
  }
}

function authenticationOptions(auth: unknown): ConnectConfig {
  if (!isRecord(auth)) throw new RemoteHostSshError('INVALID_CONFIG')
  switch (auth.kind) {
    case 'password':
      if (typeof auth.password === 'string') return { password: auth.password, authHandler: ['password'] }
      break
    case 'key':
      if (validText(auth.privateKey) && (auth.passphrase === undefined || typeof auth.passphrase === 'string')) {
        return { privateKey: auth.privateKey, ...(auth.passphrase === undefined ? {} : { passphrase: auth.passphrase }), authHandler: ['publickey'] }
      }
      break
    case 'agent':
      if (validText(auth.socket)) return { agent: auth.socket, authHandler: ['agent'], agentForward: false }
      break
    default:
      // JavaScript consumers can cross this boundary without the TypeScript union.
      throw new RemoteHostSshError('INVALID_CONFIG')
  }
  throw new RemoteHostSshError('INVALID_CONFIG')
}

/** Default ssh2 Service Provider; consumers inject `remoteHostSsh`. */
export class RemoteHostSsh extends Service implements RemoteHostSshProvider {
  static Config: schema<Config> = schema.object({
    connectTimeoutMs: schema.number().default(defaults.connectTimeoutMs),
    operationTimeoutMs: schema.number().default(defaults.operationTimeoutMs),
    maxOutputBytes: schema.number().default(defaults.maxOutputBytes),
    maxReadBytes: schema.number().default(defaults.maxReadBytes),
  })
  private readonly limits: Required<Config>
  private readonly connections = new Set<SshTransport>()
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - Owning plugin context.
   * @param config - Optional byte/time bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    const limits = { ...defaults, ...config }
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1)) {
      throw new RemoteHostSshError('INVALID_CONFIG')
    }
    super(ctx, 'remoteHostSsh')
    this.limits = limits
    ctx.effect(() => () => this.dispose())
  }

  /**
   * @param config - Per-host endpoint and approved OpenSSH SHA256 fingerprint.
   * @param authentication - Explicit credentials; no ambient identity fallback.
   * @param signal - Cancels connection establishment only.
   * @returns an authenticated, caller-owned connection.
   */
  async open(
    config: RemoteHostSshConfig, authentication: RemoteHostSshAuthentication, signal?: AbortSignal,
  ): Promise<RemoteHostSshConnection> {
    validateTarget(config)
    if (typeof config.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.fingerprint)
      || Buffer.from(config.fingerprint.slice(7), 'base64').toString('base64').replace(/=+$/, '') !== config.fingerprint.slice(7)) {
      throw new RemoteHostSshError('INVALID_CONFIG')
    }
    const auth = authenticationOptions(authentication)
    const connection = this.create(signal)
    await connection.connect(config, auth, config.fingerprint, signal)
    if (connection.signal.aborted || this.disposal !== undefined) {
      await connection.dispose()
      throw new RemoteHostSshError('CLOSED')
    }
    return connection
  }

  /**
   * @param config - Endpoint to observe, without credentials or an approved pin.
   * @param signal - Cancels the observation.
   * @returns an untrusted SHA256 fingerprint after rejecting its key and closing.
   */
  async probe(config: RemoteHostSshTarget, signal?: AbortSignal): Promise<string> {
    validateTarget(config)
    const connection = this.create(signal)
    try { return await connection.connect(config, { authHandler: [] }, undefined, signal) }
    finally { await connection.dispose() }
  }

  /** Dispose the provider and wait for every owned transport to close.
   * @returns completion after new admission stops and every owned transport closes.
   */
  dispose(): Promise<void> {
    // Publish the admission barrier before abort listeners can reenter open().
    this.disposal ??= Promise.resolve().then(async () => {
      await Promise.all([...this.connections].map(connection => connection.dispose()))
    })
    return this.disposal
  }

  private create(signal?: AbortSignal): SshTransport {
    if (this.disposal !== undefined) throw new RemoteHostSshError('CLOSED')
    if (signal?.aborted) throw new RemoteHostSshError('ABORTED')
    const connection = new SshTransport(this.limits)
    this.connections.add(connection)
    void connection.closed.then(() => { this.connections.delete(connection) })
    return connection
  }
}

export default RemoteHostSsh
