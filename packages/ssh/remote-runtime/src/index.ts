/** Locked-at-boot controls and local discovery for a process-owned remote Harness. */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-authentication'
import { EncryptedCredentialProvider } from '@deepseek-ai/dsh-credentials-encrypted'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { publishEndpoint } from './endpoint.ts'
import { syncSettings } from './settings.ts'
import type { RemoteRuntimeStatus } from './types.ts'

export type * from './types.ts'
export { SYNC_SETTINGS_NAMESPACES } from './settings.ts'

/** Endpoint discovery home; credentials use the same home in the server composition. */
export interface Config {
  /** Local home used for remote endpoint discovery and encrypted credentials. */
  dshHome?: string
  /** Exit an ownerless runtime after this long without an authenticated owner RPC (default 45s). */
  ownerlessExitMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { remoteRuntime: RemoteRuntime }
  interface Events {
    /**
     * Emitted once per starvation episode when no owner RPC arrived within the
     * configured exit window; a later owner contact re-arms the next one.
     * @mode emit
     */
    'remote-runtime/ownerless'(): void
  }
}

/** Fixed lower bound for the watchdog tick; the effective tick is `ownerlessExitMs / 5`. */
const OWNERLESS_TICK_FLOOR_MS = 50

/** Remote control provider. Browser and SSH connections never own its decrypted lifetime. */
export class RemoteRuntime extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'webServer', 'authentication', 'agents']
  static Config: z<Config> = z.object({ dshHome: z.string(), ownerlessExitMs: z.number() })
  private readonly bootId = randomUUID()
  private readonly home: string
  private readonly ownerlessExitMs: number
  private settingsTail: Promise<void> = Promise.resolve()
  private stopped = false
  private ownerless = false
  private lastOwnerContact = Date.now()
  private watchdog?: NodeJS.Timeout

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'remoteRuntime')
    this.home = resolveDshHome(config.dshHome)
    this.ownerlessExitMs = config.ownerlessExitMs ?? 45_000
    if (!Number.isSafeInteger(this.ownerlessExitMs) || this.ownerlessExitMs < OWNERLESS_TICK_FLOOR_MS * 5
      || this.ownerlessExitMs > 2_147_483_647) {
      throw new Error('remote-runtime: ownerlessExitMs must be a safe integer between 250 and 2147483647')
    }
    if (!(ctx.credentials instanceof EncryptedCredentialProvider)) {
      throw new Error('remote-runtime: ctx.credentials must be EncryptedCredentialProvider')
    }
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('remote-runtime: listener must bind strictly to 127.0.0.1')
    if (ctx.authentication.mode !== 'authenticated') throw new Error('remote-runtime: authentication is required')
    ctx.agents.registerAdmission(() => { this.assertUnlocked() })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => { this.stopped = true; clearInterval(this.watchdog); await this.settingsTail }
    const tick = Math.max(OWNERLESS_TICK_FLOOR_MS, Math.floor(this.ownerlessExitMs / 5))
    const watchdog: NodeJS.Timeout = setInterval(() => { this.checkOwner() }, tick)
    watchdog.unref()
    this.watchdog = watchdog
    const server = this.ctx.webServer
    yield await publishEndpoint(this.home, {
      version: 1, host: '127.0.0.1', port: server.port, protocol: server.protocol,
      pid: process.pid, bootId: this.bootId,
    })
  }

  /** Report lock state and process identity without credential names or values.
   * @returns the current runtime status.
   */
  @Remote({ requiredCapability: 'harniverse.observe' })
  status(): RemoteRuntimeStatus {
    this.touch()
    return { locked: this.provider().status().locked, bootId: this.bootId, platform: process.platform, arch: process.arch }
  }

  /** Unlock the encrypted credential provider for this process.
   * @param key - canonical base64url encoding of 32 random bytes from the local authority.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async unlock(key: string): Promise<void> {
    this.touch()
    await this.provider().unlock(key)
  }

  /** Replace the complete encrypted credential map.
   * @param snapshot - complete credential map; omitted references are deleted.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async replaceCredentials(snapshot: Record<string, string>): Promise<void> {
    this.touch()
    this.assertUnlocked()
    await this.provider().replace(snapshot)
  }

  /** Replace the complete model and search settings snapshot.
   * @param snapshot - complete model/search user sections; omitted registered sections reset.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async syncSettings(snapshot: Record<string, JsonValue>): Promise<void> {
    this.touch()
    this.assertUnlocked()
    const detached = structuredClone(snapshot)
    const operation = this.settingsTail.then(async () => {
      this.assertUnlocked()
      await syncSettings(this.ctx.settings, detached)
    })
    this.settingsTail = operation.catch(() => {}) // Keep later snapshots usable after a rejected write.
    await operation
  }

  /** Synchronous admission check for same-process consumers; never waits for a connection. */
  assertUnlocked(): void {
    if (this.provider().status().locked) throw new Error('remote-runtime: locked; reconnect and unlock before admitting agents')
  }

  /** Refresh the owner-liveness lease; every authenticated Remote call re-arms the watchdog. */
  private touch(): void {
    this.ownerless = false
    this.lastOwnerContact = Date.now()
  }

  /** Signal one starvation episode; a later owner contact re-arms the next one. */
  private checkOwner(): void {
    if (this.stopped || this.ownerless || Date.now() - this.lastOwnerContact <= this.ownerlessExitMs) return
    this.ownerless = true
    this.ctx.logger.warn('remote-runtime: no owner contact for %dms; signaling ownerless', this.ownerlessExitMs)
    this.ctx.emit('remote-runtime/ownerless')
  }

  private provider(): EncryptedCredentialProvider {
    if (this.stopped) throw new Error('remote-runtime: disposed')
    const provider = this.ctx.credentials
    /* v8 ignore next -- the injected service is type-checked by construction; this is a defensive topology fence. */
    if (!(provider instanceof EncryptedCredentialProvider)) throw new Error('remote-runtime: encrypted provider unavailable')
    return provider
  }
}

export default RemoteRuntime
