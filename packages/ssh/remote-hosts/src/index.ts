/** Local authoritative registry and SSH deployment provider; Remote consumers manage it on the local host. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-remote-hosts-ssh'
// Side-effect type import: resolves `ctx.get('directoryPicker')` for the key-file picking interaction.
import type {} from '@deepseek-ai/dsh-host-directory-picker'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HostRegistry } from './registry.ts'
import { authentication, resolveKeySecrets, storeAuthentication } from './secrets.ts'
import { detect } from './detect.ts'
import { detectCommand } from './platform.ts'
import { listKeyDirectory } from './keyfiles.ts'
import { establish, HostSession, synchronize } from './session.ts'
import { authSecrets, connectSchema, listKeyFilesSchema, parseHostInput, remoteHostId, RemoteHostsError, upsertSchema, verifySchema } from './validation.ts'
import type { ActiveReverseMapping, Config, ConnectHostInput, ConnectivityResult, HostRecord, KeyFileListing, KeyFilePicker, ListKeyFilesInput, PickKeyFileResult, RemoteHostId, RemoteHostsProvider, RemoteHostState, RemoteHostView, UpsertHostInput, VerifyHostInput, RemoteHostProgress } from './types.ts'

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
  private readonly states = new Map<RemoteHostId, { state: RemoteHostState; error?: string; progress?: RemoteHostProgress }>()
  private readonly sessions = new Map<RemoteHostId, HostSession>()
  private readonly attempts = new Map<RemoteHostId, AbortController>()
  private readonly queues = new Map<RemoteHostId, Promise<unknown>>()
  private readonly connects = new Map<RemoteHostId, Promise<RemoteHostView>>()
  private readonly lifetime = new AbortController()
  private readonly verifications = new Set<Promise<unknown>>()

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
      await Promise.allSettled([...this.queues.values(), ...this.verifications])
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

  /** @param input - SSH target and explicit credentials. @returns what a successful authenticated test proved about the target. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async verify(input: VerifyHostInput): Promise<ConnectivityResult> {
    const target = this.validate(() => verifySchema.parse(input))
    this.lifetime.signal.throwIfAborted()
    const operation = this.ctx.remoteHostSsh.verify({ host: target.host, username: target.username,
      ...(target.port === undefined ? {} : { port: target.port }) }, await resolveKeySecrets(authSecrets(target.secrets)),
    detectCommand(), this.lifetime.signal)
    this.verifications.add(operation)
    try {
      const { fingerprint, output } = await operation
      return { fingerprint, ...detect(output) }
    } catch (error) {
      // A reachable target on an unsupported platform is actionable; every other
      // failure stays the fixed connectivity-test diagnosis.
      if (error instanceof RemoteHostsError) throw error
      throw new RemoteHostsError('VERIFY_FAILED')
    } finally { this.verifications.delete(operation) }
  }

  /** The key-file interaction this host serves: the OS chooser when the operator sits at its display, else in-app browsing. */
  private keyFileInteraction(): 'native' | 'browse' {
    return this.ctx.get('directoryPicker')?.capability().kind === 'native' ? 'native' : 'browse'
  }

  /**
   * Reports the served key-file interaction so clients render the matching
   * affordance: `native` opens the host's own single-file chooser, `browse`
   * serves the in-app directory listing below.
   */
  @Remote({ requiredCapability: 'harniverse.observe' })
  keyFilePicker(): Promise<KeyFilePicker> {
    return Promise.resolve({ kind: this.keyFileInteraction() })
  }

  /**
   * List one host directory level for the in-app key browser.
   * @param input - host directory to list; absent starts at the operator's `~/.ssh`.
   * @returns one bounded level of directories and files.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async listKeyFiles(input: ListKeyFilesInput): Promise<KeyFileListing> {
    return listKeyDirectory(this.validate(() => listKeyFilesSchema.parse(input)).path)
  }

  /** Opens the host's native key-file chooser seeded at `~/.ssh`. @returns the picked host-local path, or nothing when cancelled. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async pickKeyFile(): Promise<PickKeyFileResult> {
    this.lifetime.signal.throwIfAborted()
    const capability = this.ctx.get('directoryPicker')?.capability()
    if (capability?.kind !== 'native') throw new RemoteHostsError('KEY_PICKER_UNAVAILABLE')
    let path: string | null
    try {
      // The adapters drop a start directory the host cannot access.
      path = await capability.pickFile(this.lifetime.signal, {
        title: 'Select SSH Private Key', defaultDirectory: join(homedir(), '.ssh'),
      })
    } catch {
      // A foreign failure never leaks chooser internals to the wire.
      throw new RemoteHostsError('KEY_PICKER_FAILED')
    }
    return path === null ? {} : { path }
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
        await establish(session, host, this.config, this.ctx.credentials, this.ctx.settings,
          (state, progress: RemoteHostProgress) => this.states.set(id, { state, progress }))
        signal.throwIfAborted()
        this.states.set(id, { state: 'connected' })
        return this.view(host)
      } catch (error) {
        const cancelled = signal.aborted
        await this.close(id)
        if (!(error instanceof RemoteHostsError)) {
          // The wire stays fixed; the host log keeps the swallowed cause's class
          // and code (never its message, which may carry commands or paths).
          const { name, code } = Object(error) as { name?: unknown; code?: unknown }
          this.ctx.logger('remote-hosts').warn('connect failed: %s %s', String(name), String(code))
        }
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
