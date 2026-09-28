/** Local authoritative registry and SSH deployment provider; Remote consumers manage it on the local host. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-remote-hosts-ssh'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HostRegistry } from './registry.ts'
import { authentication, storeAuthentication } from './secrets.ts'
import { establish, HostSession, synchronize } from './session.ts'
import { authSecrets, connectSchema, parseHostInput, probeSchema, remoteHostId, RemoteHostsError, upsertSchema } from './validation.ts'
import type { ActiveReverseMapping, Config, ConnectHostInput, HostRecord, ProbeHostInput, RemoteHostId, RemoteHostsProvider, RemoteHostState, RemoteHostView, UpsertHostInput } from './types.ts'

export type * from './types.ts'
export { remoteHostId, RemoteHostsError } from './validation.ts'
declare module '@deepseek-ai/cordis' { interface Context { remoteHosts: RemoteHostsProvider } }

/** Service Definition + Provider. Typert management and trusted proxy plugins are Consumers. */
export class RemoteHosts extends TypertRemoteService implements RemoteHostsProvider {
  static inject = ['remoteHostSsh', 'credentials', 'settings']
  static Config: z<Config> = z.object({ dshHome: z.string(), artifactsRoot: z.string().required(),
    startupTimeoutMs: z.natural().min(1).max(2147483647).default(60_000),
    requestTimeoutMs: z.natural().min(1).max(2147483647).default(30_000) })
  private readonly registry: HostRegistry
  private readonly ready: Promise<void>
  private readonly states = new Map<RemoteHostId, { state: RemoteHostState; error?: string }>()
  private readonly sessions = new Map<RemoteHostId, HostSession>()
  private readonly attempts = new Map<RemoteHostId, AbortController>()
  private readonly queues = new Map<RemoteHostId, Promise<unknown>>()
  private readonly connects = new Map<RemoteHostId, Promise<RemoteHostView>>()
  private readonly lifetime = new AbortController()
  private readonly probes = new Set<Promise<string>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteHosts')
    if (!isAbsolute(config.artifactsRoot)) throw new RemoteHostsError('ARTIFACT_ROOT_NOT_ABSOLUTE')
    for (const timeout of [config.startupTimeoutMs, config.requestTimeoutMs]) {
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)) throw new RemoteHostsError('INVALID_TIMEOUT')
    }
    this.registry = new HostRegistry(resolveDshHome(config.dshHome))
    this.ready = this.registry.load()
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      this.lifetime.abort()
      for (const attempt of this.attempts.values()) attempt.abort()
      for (const session of this.sessions.values()) session.controller.abort()
      await Promise.allSettled([...this.queues.values(), ...this.probes])
      await Promise.all([...this.sessions.values()].map(session => session.dispose()))
      this.sessions.clear()
    }
    await this.ready
  }

  /** @returns nonsecret records and local connection states; poll for progress. */
  @Remote({ requiredCapability: 'harniverse.observe' })
  async list(): Promise<RemoteHostView[]> {
    await this.ready
    return this.registry.list().map(host => this.view(host))
  }

  /** @param input - complete host replacement and optionally explicitly stored login secrets. @returns safe committed record. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async upsert(input: UpsertHostInput): Promise<RemoteHostView> {
    const parsed = this.validate(() => upsertSchema.parse(input))
    const id = remoteHostId(parsed.id ?? randomUUID())
    return this.serial(id, async () => {
      if (parsed.id !== undefined) this.registry.get(id)
      if (this.sessions.has(id)) throw new RemoteHostsError('DISCONNECT_BEFORE_EDIT')
      const { secrets, storeCredentials, id: _id, ...fields } = parsed
      let record: HostRecord = { ...parseHostInput(fields), id }
      if (secrets !== undefined) {
        if (!storeCredentials) throw new RemoteHostsError('EPHEMERAL_SECRETS_REQUIRE_CONNECT')
        record = await storeAuthentication(this.ctx.credentials, record, authSecrets(secrets))
      }
      await this.registry.put(record)
      this.states.set(id, { state: 'offline' })
      return this.view(record)
    })
  }

  /** @param id - host to forget locally; remote storage and processes survive. */
  @Remote({ requiredCapability: 'harniverse.administer', exportName: 'removeHost' })
  async remove(id: RemoteHostId): Promise<void> {
    id = this.validate(() => remoteHostId(id))
    this.attempts.get(id)?.abort()
    this.sessions.get(id)?.controller.abort()
    await this.serial(id, async () => {
      this.registry.get(id)
      await this.close(id)
      await this.registry.remove(id)
      this.states.delete(id)
    })
  }

  /** @param input - unauthenticated SSH target. @returns untrusted observation requiring explicit independent approval. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async probe(input: ProbeHostInput): Promise<{ fingerprint: string }> {
    const target = this.validate(() => probeSchema.parse(input))
    this.lifetime.signal.throwIfAborted()
    const operation = this.ctx.remoteHostSsh.probe({ host: target.host, username: target.username,
      ...(target.port === undefined ? {} : { port: target.port }) }, this.lifetime.signal)
    this.probes.add(operation)
    try { return { fingerprint: await operation } } catch { throw new RemoteHostsError('PROBE_FAILED') }
    finally { this.probes.delete(operation) }
  }

  /** @param input - stable identity and optional ephemeral login. @returns connected only after authenticated complete synchronization. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async connect(input: ConnectHostInput): Promise<RemoteHostView> {
    const parsed = this.validate(() => connectSchema.parse(input))
    const id = remoteHostId(parsed.id)
    const existing = this.connects.get(id)
    if (existing !== undefined) return existing
    const controller = new AbortController()
    this.attempts.set(id, controller)
    const operation = this.serial(id, async () => {
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
      let host = this.registry.get(id)
      try {
        signal.throwIfAborted()
        if (parsed.secrets !== undefined && parsed.secrets.kind !== host.authentication.kind) throw new RemoteHostsError('AUTH_KIND_MISMATCH')
        if (parsed.secrets !== undefined && parsed.storeCredentials) {
          host = await storeAuthentication(this.ctx.credentials, host, authSecrets(parsed.secrets))
          await this.registry.put(host)
        }
        let current = this.sessions.get(id)
        if (current?.connection.signal.aborted) { await this.close(id); current = undefined }
        if (current !== undefined) {
          await synchronize(current, this.ctx.credentials, this.ctx.settings)
          signal.throwIfAborted()
          return this.view(host)
        }
        this.states.set(id, { state: 'connecting' })
        const secrets = parsed.secrets === undefined ? undefined : authSecrets(parsed.secrets)
        const auth = await authentication(this.ctx.credentials, host, secrets)
        const connection = await this.ctx.remoteHostSsh.open(host, auth, signal)
        const session = new HostSession(connection, controller)
        this.sessions.set(id, session)
        connection.signal.addEventListener('abort', () => {
          if (this.sessions.get(id) !== session) return
          this.states.set(id, { state: controller.signal.aborted ? 'offline' : 'error',
            ...(controller.signal.aborted ? {} : { error: 'remote-hosts: CONNECTION_LOST' }) })
        }, { once: true })
        await establish(session, host, this.config, this.ctx.credentials, this.ctx.settings, state => this.states.set(id, { state }))
        signal.throwIfAborted()
        this.states.set(id, { state: 'connected' })
        return this.view(host)
      } catch (error) {
        const cancelled = signal.aborted
        await this.close(id)
        const safe = error instanceof RemoteHostsError ? error : new RemoteHostsError('CONNECT_FAILED')
        this.states.set(id, cancelled ? { state: 'offline' } : { state: 'error', error: safe.message })
        throw safe
      }
    })
    this.connects.set(id, operation)
    try { return await operation } finally {
      this.attempts.delete(id)
      this.connects.delete(id)
    }
  }

  /** @param id - host whose SSH transport and forwards close; no remote shutdown is sent. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async disconnect(id: RemoteHostId): Promise<void> {
    id = this.validate(() => remoteHostId(id))
    this.attempts.get(id)?.abort()
    this.sessions.get(id)?.controller.abort()
    await this.serial(id, async () => { this.registry.get(id); await this.close(id); this.states.set(id, { state: 'offline' }) })
  }

  /**
   * Same-process proxy Consumer only.
   * @param id - connected host. @param path - same-origin /api path.
   * @param init - HTTP options. @returns authenticated response.
   */
  async request(id: RemoteHostId, path: string, init?: RequestInit): Promise<Response> {
    const session = this.connected(id)
    const transport = session.transport
    if (!transport) throw new RemoteHostsError('NOT_CONNECTED')
    try { return await transport.request(path, init) } catch { throw new RemoteHostsError('REQUEST_FAILED') }
  }

  /** Open one authenticated remote event WebSocket through the connected SSH forward. */
  async openWebSocket(id: RemoteHostId, path: string, signal?: AbortSignal): Promise<unknown> {
    const session = this.connected(id)
    if (!session.transport) throw new RemoteHostsError('NOT_CONNECTED')
    try { return await session.transport.openWebSocket(path, signal) } catch { throw new RemoteHostsError('REQUEST_FAILED') }
  }

  /** Return the remote carrier identity observed by the last JSON response. */
  authentication(id: RemoteHostId): unknown {
    const session = this.connected(id)
    return session.transport?.authentication()
  }

  /** @param id - connected host. @returns explicit mapping ports for the runtime gateway Consumer. */
  reverseMappings(id: RemoteHostId): readonly ActiveReverseMapping[] { return structuredClone(this.connected(id).mappings) }

  private connected(id: RemoteHostId): HostSession {
    const session = this.sessions.get(id)
    if (this.lifetime.signal.aborted || this.states.get(id)?.state !== 'connected' || !session || session.connection.signal.aborted) throw new RemoteHostsError('NOT_CONNECTED')
    return session
  }
  private view(host: HostRecord): RemoteHostView { return { ...host, ...this.states.get(host.id) ?? { state: 'offline' as const } } }
  private async close(id: RemoteHostId): Promise<void> {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (session) await session.dispose()
  }
  private validate<T>(operation: () => T): T {
    try { return operation() } catch { throw new RemoteHostsError('INVALID_INPUT') }
  }
  private async serial<T>(id: RemoteHostId, operation: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    const previous = this.queues.get(id)
    const work = Promise.resolve(previous).catch(() => {}).then(async () => {
      await this.ready
      this.lifetime.signal.throwIfAborted()
      try { return await operation() } catch (error) {
        throw error instanceof RemoteHostsError ? error : new RemoteHostsError('OPERATION_FAILED')
      }
    })
    this.queues.set(id, work)
    try { return await work } finally { if (this.queues.get(id) === work) this.queues.delete(id) }
  }
}

export default RemoteHosts
