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
export interface Config { dshHome?: string }

declare module '@deepseek-ai/cordis' {
  interface Context { remoteRuntime: RemoteRuntime }
}

/** Remote control provider. Browser and SSH connections never own its decrypted lifetime. */
export class RemoteRuntime extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'webServer', 'authentication', 'agents']
  static Config: z<Config> = z.object({ dshHome: z.string() })
  private readonly bootId = randomUUID()
  private readonly home: string
  private settingsTail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'remoteRuntime')
    this.home = resolveDshHome(config.dshHome)
    if (!(ctx.credentials instanceof EncryptedCredentialProvider)) {
      throw new Error('remote-runtime: ctx.credentials must be EncryptedCredentialProvider')
    }
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('remote-runtime: listener must bind strictly to 127.0.0.1')
    if (ctx.authentication.mode !== 'authenticated') throw new Error('remote-runtime: authentication is required')
    ctx.agents.registerAdmission(() => { this.assertUnlocked() })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => { this.stopped = true; await this.settingsTail }
    const server = this.ctx.webServer
    yield await publishEndpoint(this.home, {
      version: 1, host: '127.0.0.1', port: server.port, protocol: server.protocol,
      pid: process.pid, bootId: this.bootId,
    })
  }

  /** @returns lock state and process identity without credential names or values. */
  @Remote({ requiredCapability: 'harniverse.observe' })
  status(): RemoteRuntimeStatus {
    return { locked: this.provider().status().locked, bootId: this.bootId, platform: process.platform, arch: process.arch }
  }

  /** @param key - canonical base64url encoding of 32 random bytes from the local authority. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async unlock(key: string): Promise<void> {
    await this.provider().unlock(key)
  }

  /** @param snapshot - complete credential map; omitted references are deleted. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async replaceCredentials(snapshot: Record<string, string>): Promise<void> {
    this.assertUnlocked()
    await this.provider().replace(snapshot)
  }

  /** @param snapshot - complete model/search user sections; omitted registered sections reset. */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async syncSettings(snapshot: Record<string, JsonValue>): Promise<void> {
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

  private provider(): EncryptedCredentialProvider {
    if (this.stopped) throw new Error('remote-runtime: disposed')
    const provider = this.ctx.credentials
    if (!(provider instanceof EncryptedCredentialProvider)) throw new Error('remote-runtime: encrypted provider unavailable')
    return provider
  }
}

export default RemoteRuntime
