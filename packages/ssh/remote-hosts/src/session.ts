import { setTimeout as delay } from 'node:timers/promises'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { RemoteHostSshConnection, RemoteHostSshForward } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { inspectArtifact } from './artifact.ts'
import { bootstrapGrant, deploy, processAlive, startDetached } from './deploy.ts'
import { nodeCommand, remoteHome } from './platform.ts'
import { identity } from './secrets.ts'
import { buildSnapshot } from './sync.ts'
import { endpointSchema, HostTransport, statusSchema, type Endpoint } from './transport.ts'
import type { ActiveReverseMapping, Config, HostRecord, RemoteHostProgress, RemoteHostState } from './types.ts'
import { RemoteHostsError } from './validation.ts'

/** All local transport resources belong to this connection attempt's controller. */
export class HostSession {
  /** Authenticated HTTP transport over the SSH forward. */
  transport?: HostTransport
  /** Active reverse mapping handles and allocated remote ports. */
  mappings: ActiveReverseMapping[] = []
  private heartbeat?: NodeJS.Timeout
  constructor(readonly connection: RemoteHostSshConnection, readonly controller: AbortController) {}
  /** Keep the remote runtime's owner lease fresh while this session owns it. */
  beginOwnerHeartbeat(intervalMs: number): void {
    this.heartbeat ??= setInterval(() => {
      // Connection-loss detection owns failure reporting; a missed keepalive retries next tick.
      void this.transport?.rpc('status', {}).catch(() => {})
    }, intervalMs)
    this.heartbeat.unref()
    this.connection.signal.addEventListener('abort', () => { clearInterval(this.heartbeat) }, { once: true })
  }
  /** Abort the session and dispose its SSH transport. */
  async dispose(): Promise<void> {
    clearInterval(this.heartbeat)
    this.controller.abort()
    await this.connection.dispose()
  }
}

async function discovery(
  connection: RemoteHostSshConnection, host: HostRecord, home: string, release: string, signal: AbortSignal,
): Promise<Endpoint | undefined> {
  const script = `import {readFile,lstat} from 'node:fs/promises';const p=process.env.DSH_HOME+'/server/endpoint.json';try{
const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size>4096)throw Error('invalid endpoint');
process.stdout.write(JSON.stringify({endpoint:JSON.parse(await readFile(p,'utf8'))}));
}catch(e){if(e.code==='ENOENT')process.stdout.write('{}');else throw e}`
  const result = await connection.exec(nodeCommand(host.platform, release, home, script), undefined, signal)
  if (result.exitCode !== 0 || result.signal !== null) throw new RemoteHostsError('ENDPOINT_READ_FAILED')
  const value = JSON.parse(result.stdout.toString('utf8')) as { endpoint?: unknown }
  return value.endpoint === undefined ? undefined : endpointSchema.parse(value.endpoint)
}

/** Deploy, start, authenticate, and synchronize one remote session.
 * @param session - connection-owned session state.
 * @param host - configured remote host.
 * @param config - local deployment limits and artifact root.
 * @param provider - local credential provider.
 * @param settings - local settings provider.
 * @param phase - publishes each deployment state with its bounded progress.
 */
export async function establish(
  session: HostSession, host: HostRecord, config: Config, provider: CredentialProvider, settings: SettingsProvider,
  heartbeatIntervalMs: number,
  phase: (state: RemoteHostState, progress: RemoteHostProgress) => void,
): Promise<void> {
  const connection = session.connection
  const signal = AbortSignal.any([session.controller.signal, connection.signal])
  const home = remoteHome(host.platform, await connection.realpath('.', signal), host.dshHome)
  phase('deploying', { phase: 'checking-artifact', current: 0, total: 1 })
  const artifact = await inspectArtifact(config.artifactsRoot, host.platform, host.architecture)
  signal.throwIfAborted()
  const release = await deploy(connection, host, home, artifact, signal, (progress) => { phase('deploying', progress) })
  phase('deploying', { phase: 'authorizing', current: 1, total: 1 })
  const keys = await identity(provider, host.id)
  const grant = await bootstrapGrant(connection, host, home, release, keys.publicKey, signal)
  phase('deploying', { phase: 'starting', current: 1, total: 1 })
  let endpoint = await discovery(connection, host, home, release, signal)
  const live = endpoint !== undefined && await processAlive(connection, host, home, release, endpoint.pid, signal)
  const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(config.startupTimeoutMs ?? 60_000)])
  if (!live) await startDetached(connection, host, home, release, startupSignal)
  let forward: RemoteHostSshForward | undefined
  while (true) {
    startupSignal.throwIfAborted()
    if (!live) endpoint = await discovery(connection, host, home, release, startupSignal)
    if (endpoint !== undefined) {
      let processIsAlive = live
      if (!processIsAlive) processIsAlive = await processAlive(connection, host, home, release, endpoint.pid, startupSignal)
      if (processIsAlive) {
        // This app binds HTTP loopback; TLS deployments require explicit certificate trust integration.
        if (endpoint.protocol !== 'http:') throw new RemoteHostsError('UNSUPPORTED_ENDPOINT_TLS')
        phase('deploying', { phase: 'forwarding', current: 1, total: 1 })
        forward = await connection.forward('127.0.0.1', endpoint.port, startupSignal)
        const transport = new HostTransport(forward.port, grant, provider, host.id, signal, config.requestTimeoutMs ?? 30_000)
        try {
          const status = statusSchema.parse(await transport.rpc('status', {}, startupSignal))
          if (status.bootId !== endpoint.bootId || status.platform !== host.platform || status.arch !== host.architecture) {
            throw new RemoteHostsError('ENDPOINT_IDENTITY_MISMATCH')
          }
          session.transport = transport
          break
        } catch (error) {
          await forward.close()
          if (live) throw error
          if (error instanceof RemoteHostsError && error.reason === 'ENDPOINT_IDENTITY_MISMATCH') throw error
        }
      }
    }
    /* v8 ignore next -- the deterministic fixture reaches the endpoint immediately; this is the real startup polling backoff. */
    await delay(200, undefined, { signal: startupSignal })
  }
  for (const mapping of host.reverseMappings) {
    const handle = await connection.reverse({ localHost: mapping.localHost, localPort: mapping.localPort }, signal)
    session.mappings.push({ ...mapping, remotePort: handle.port })
  }
  phase('deploying', { phase: 'synchronizing', current: 1, total: 1 })
  await session.transport.rpc('unlock', { key: keys.aes })
  await synchronize(session, provider, settings)
  session.beginOwnerHeartbeat(heartbeatIntervalMs)
  signal.throwIfAborted()
}

/** Synchronize complete credentials and model/search settings to a connected host.
 * @param session - connected host session.
 * @param provider - local credential provider.
 * @param settings - local settings provider.
 */
export async function synchronize(session: HostSession, provider: CredentialProvider, settings: SettingsProvider): Promise<void> {
  if (session.transport === undefined) throw new RemoteHostsError('NOT_CONNECTED')
  const snapshot = await buildSnapshot(settings, provider, session.mappings)
  await session.transport.rpc('replaceCredentials', { snapshot: snapshot.credentials })
  await session.transport.rpc('syncSettings', { snapshot: snapshot.settings })
}
