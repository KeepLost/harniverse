/** Local named-token provider for all inbound network authentication. */
import { randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import {
  InboundAuthentication,
  type AuthenticationAttempt,
  type AuthenticationCredential,
  type AuthenticationDecision,
  type AuthenticationMode,
  type AuthenticationStatus,
  type BrowserAuthenticationDecision,
} from '@deepseek-ai/dsh-authentication'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { appendAccessRecord, type AccessRecord } from './access-log.ts'
import { acquireAuthenticationLease } from './instance-lease.ts'
import {
  authenticationTokenRegistryPath,
  readAuthenticationTokenRegistry,
  verifyAuthenticationToken,
} from './management.ts'

export {
  addAuthenticationToken,
  authenticationTokenRegistryPath,
  deleteAuthenticationToken,
  listAuthenticationTokens,
  parseAuthenticationTokenRegistry,
  readAuthenticationTokenRegistry,
  resetAuthenticationToken,
  verifyAuthenticationToken,
  type AuthenticationManagementOptions,
  type AuthenticationTokenInfo,
  type GeneratedAuthenticationToken,
} from './management.ts'

const COOKIE_NAME = 'dsh_auth'

/** Local authentication plugin configuration. */
export interface Config {
  /** Harness home containing the registry, access log, and instance lease. */
  dshHome?: string
  /** Admission behavior; authenticated is the default. */
  mode?: AuthenticationMode
  /** Watch token management changes and publish targeted revocations. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds. */
  debounceMs?: number
  /** Browser session lifetime in milliseconds. */
  sessionTtlMs?: number
  /** Maximum process-memory browser sessions retained at once. */
  maxBrowserSessions?: number
  /** Registry reconciliation interval backing up filesystem watch events. */
  reconcileIntervalMs?: number
  /** Maximum active access-log size before rotation. */
  accessLogMaxBytes?: number
  /** Number of rotated access-log files retained. */
  accessLogMaxFiles?: number
}

interface ResolvedSpec {
  dshHome?: string
  mode: AuthenticationMode
  watch: boolean
  debounceMs: number
  sessionTtlMs: number
  maxBrowserSessions: number
  reconcileIntervalMs: number
  accessLogMaxBytes: number
  accessLogMaxFiles: number
}

interface BrowserSession {
  credential: AuthenticationCredential
  expiresAt: number
}

/** Stable Cordis service name. */
export const name = 'authentication-local'

/**
 * Resolve defaults for Loader and programmatic construction alike.
 * @param config - raw plugin configuration.
 * @returns complete provider parameters.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    ...(config.dshHome !== undefined && { dshHome: config.dshHome }),
    mode: config.mode ?? 'authenticated',
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
    sessionTtlMs: config.sessionTtlMs ?? 24 * 60 * 60 * 1000,
    maxBrowserSessions: config.maxBrowserSessions ?? 1_024,
    reconcileIntervalMs: config.reconcileIntervalMs ?? 5_000,
    accessLogMaxBytes: config.accessLogMaxBytes ?? 10 * 1024 * 1024,
    accessLogMaxFiles: config.accessLogMaxFiles ?? 5,
  }
}

function credentialKey(credential: AuthenticationCredential): string {
  return `${credential.tokenId}:${String(credential.generation)}`
}

function cookieSession(cookie: string | undefined): string | undefined {
  if (cookie === undefined) return undefined
  const values = cookie.split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE_NAME}=`))
    .map(part => part.slice(COOKIE_NAME.length + 1))
  const value = values[0]
  return values.length === 1 && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}

/** Named-token provider with process-local browser sessions and durable access records. */
export class LocalAuthentication extends InboundAuthentication {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    mode: z.union([z.const('authenticated'), z.const('bypass')]).default('authenticated'),
    watch: z.boolean().default(true),
    debounceMs: z.natural().default(100),
    sessionTtlMs: z.natural().min(1).default(24 * 60 * 60 * 1000),
    maxBrowserSessions: z.natural().min(1).default(1_024),
    reconcileIntervalMs: z.natural().min(1).default(5_000),
    accessLogMaxBytes: z.natural().min(1).default(10 * 1024 * 1024),
    accessLogMaxFiles: z.natural().min(1).default(5),
  })

  readonly mode: AuthenticationMode
  private readonly spec: ResolvedSpec
  private readonly sessions = new Map<string, BrowserSession>()
  private credentials = new Map<string, AuthenticationCredential>()
  private operations: Promise<void> = Promise.resolve()
  private watcherHealthy = true
  private closed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.mode = this.spec.mode
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const lease = await acquireAuthenticationLease({
      ...(this.spec.dshHome !== undefined && { dshHome: this.spec.dshHome }),
      mode: this.mode,
    })
    yield async () => {
      this.closed = true
      await this.operations
      try {
        await this.record({ event: 'instance-stopped', mode: this.mode })
      } finally {
        await lease.release()
      }
    }

    const registry = await readAuthenticationTokenRegistry(this.spec)
    this.credentials = new Map(registry.tokens.map((token) => {
      const credential = { tokenId: token.id, tokenName: token.name, generation: token.generation }
      return [credentialKey(credential), credential]
    }))
    if (this.mode === 'authenticated' && registry.tokens.length === 0) {
      await this.record({ event: 'instance-start-rejected', mode: this.mode, reasonCode: 'no-tokens' })
      throw new Error('authentication-local: authenticated startup requires at least one token; run "dsh auth token add <name>" first')
    }
    await this.record({ event: 'instance-started', mode: this.mode })
    if (!this.spec.watch) return

    const path = authenticationTokenRegistryPath(this.spec.dshHome)
    const watcher = chokidarWatch(await canonicalizeWatchPath(path), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    watcher.on('all', () => { this.queueRefresh() })
    watcher.on('ready', () => { this.queueRefresh() })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('authentication-local: token registry watcher failed')
      this.ctx.logger.warn(error)
      this.queueWatcherFailure()
    })
    const reconciliation = setInterval(() => { this.queueRefresh() }, this.spec.reconcileIntervalMs)
    reconciliation.unref()
    yield async () => {
      this.closed = true
      clearInterval(reconciliation)
      await watcher.close()
      await this.operations
    }
  }

  override async status(): Promise<AuthenticationStatus> {
    if (this.mode === 'bypass') return { mode: this.mode, sealed: false }
    const registry = await readAuthenticationTokenRegistry(this.spec)
    return { mode: this.mode, sealed: registry.tokens.length === 0 }
  }

  override async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationDecision> {
    return this.enqueue(async () => {
      let decision: AuthenticationDecision
      if (this.mode === 'bypass') decision = { kind: 'accepted' }
      else if (!this.watcherHealthy) decision = { kind: 'rejected', reason: 'authentication-unavailable' }
      else {
        try {
          decision = await this.decide(attempt)
        } catch (error) {
          this.ctx.logger.warn('authentication-local: credential verification unavailable')
          this.ctx.logger.warn(error)
          decision = { kind: 'rejected', reason: 'authentication-unavailable' }
        }
      }
      const record: AccessRecord = {
        time: new Date().toISOString(),
        event: decision.kind === 'accepted' ? 'access-accepted' : 'access-rejected',
        mode: this.mode,
        channel: attempt.channel,
        outcome: decision.kind === 'accepted' ? 'accepted' : 'rejected',
        ...(attempt.peerAddress !== undefined && { peer: attempt.peerAddress }),
        ...(decision.kind === 'accepted' && decision.credential !== undefined
          && { tokenName: decision.credential.tokenName }),
        ...(decision.kind === 'rejected' && { reasonCode: decision.reason }),
      }
      try {
        await this.record(record)
      } catch (error) {
        this.ctx.logger.warn('authentication-local: access record failed')
        this.ctx.logger.warn(error)
        if (decision.kind === 'accepted') return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return decision
    })
  }

  override async createBrowserSession(token: string, peerAddress?: string): Promise<BrowserAuthenticationDecision> {
    if (this.mode === 'bypass') return { kind: 'rejected', reason: 'authentication-unavailable' }
    return this.enqueue(async () => {
      if (!this.watcherHealthy) return { kind: 'rejected', reason: 'authentication-unavailable' }
      let credential: AuthenticationCredential | undefined
      try {
        credential = await verifyAuthenticationToken(token, this.spec)
      } catch (error) {
        this.ctx.logger.warn('authentication-local: browser login verification unavailable')
        this.ctx.logger.warn(error)
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      if (credential === undefined) {
        await this.recordLogin('rejected', peerAddress, undefined, 'invalid-credential')
        return { kind: 'rejected', reason: 'invalid-credential' }
      }
      this.credentials.set(credentialKey(credential), credential)
      await this.recordLogin('accepted', peerAddress, credential)
      const value = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + this.spec.sessionTtlMs
      this.pruneBrowserSessions()
      this.sessions.set(value, { credential, expiresAt })
      return {
        kind: 'accepted',
        session: { value, expiresAt: new Date(expiresAt).toISOString(), credential },
      }
    })
  }

  override revokeBrowserSession(cookie?: string): void {
    const value = cookieSession(cookie)
    if (value !== undefined) this.sessions.delete(value)
  }

  private async decide(attempt: AuthenticationAttempt): Promise<AuthenticationDecision> {
    if (attempt.authorization !== undefined) {
      const match = /^Bearer ([^\s]+)$/.exec(attempt.authorization)
      if (match === null) return { kind: 'rejected', reason: 'invalid-credential' }
      const value = match[1]
      if (value === undefined) return { kind: 'rejected', reason: 'invalid-credential' }
      const credential = await verifyAuthenticationToken(value, this.spec)
      if (credential !== undefined) this.credentials.set(credentialKey(credential), credential)
      return credential === undefined
        ? { kind: 'rejected', reason: 'invalid-credential' }
        : { kind: 'accepted', credential }
    }
    const sessionValue = cookieSession(attempt.cookie)
    if (sessionValue === undefined) return { kind: 'rejected', reason: 'missing-credential' }
    const session = this.sessions.get(sessionValue)
    if (session === undefined) return { kind: 'rejected', reason: 'invalid-credential' }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionValue)
      return { kind: 'rejected', reason: 'invalid-credential' }
    }
    const registry = await readAuthenticationTokenRegistry(this.spec)
    const active = registry.tokens.some(token => token.id === session.credential.tokenId
      && token.generation === session.credential.generation)
    if (!active) {
      this.sessions.delete(sessionValue)
      return { kind: 'rejected', reason: 'invalid-credential' }
    }
    return { kind: 'accepted', credential: session.credential }
  }

  private record(record: Omit<AccessRecord, 'time'> & { time?: string }): Promise<void> {
    return appendAccessRecord({ time: record.time ?? new Date().toISOString(), ...record }, {
      ...(this.spec.dshHome !== undefined && { dshHome: this.spec.dshHome }),
      maxBytes: this.spec.accessLogMaxBytes,
      maxFiles: this.spec.accessLogMaxFiles,
    })
  }

  private recordLogin(
    outcome: 'accepted' | 'rejected',
    peer: string | undefined,
    credential?: AuthenticationCredential,
    reasonCode?: string,
  ): Promise<void> {
    return this.record({
      event: outcome === 'accepted' ? 'browser-login-accepted' : 'browser-login-rejected',
      mode: this.mode,
      channel: 'browser-login',
      outcome,
      ...(peer !== undefined && { peer }),
      ...(credential !== undefined && { tokenName: credential.tokenName }),
      ...(reasonCode !== undefined && { reasonCode }),
    })
  }

  private queueRefresh(): void {
    if (this.closed) return
    const task = this.enqueue(async () => {
      try {
        await this.refresh()
      } catch (error) {
        this.ctx.logger.warn('authentication-local: token registry reload failed; keeping the last good registry')
        this.ctx.logger.warn(error)
        this.markAuthenticationUnavailable()
      }
    })
    void task.catch((error: unknown) => {
      this.ctx.logger.warn('authentication-local: registry refresh failure containment failed')
      this.ctx.logger.warn(error)
    })
  }

  private queueWatcherFailure(): void {
    if (this.closed) return
    const task = this.enqueue(() => {
      this.markAuthenticationUnavailable()
      return Promise.resolve()
    })
    void task.catch((error: unknown) => {
      this.ctx.logger.warn('authentication-local: watcher failure containment failed')
      this.ctx.logger.warn(error)
    })
  }

  private markAuthenticationUnavailable(): void {
    if (this.mode === 'bypass' || !this.watcherHealthy) return
    this.watcherHealthy = false
    this.sessions.clear()
    this.ctx.emit('authentication/unavailable')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private async refresh(): Promise<void> {
    if (this.closed) return
    const recovering = !this.watcherHealthy
    const registry = await readAuthenticationTokenRegistry(this.spec)
    const next = new Map<string, AuthenticationCredential>()
    for (const token of registry.tokens) {
      const credential = { tokenId: token.id, tokenName: token.name, generation: token.generation }
      next.set(credentialKey(credential), credential)
    }
    const revoked = [...this.credentials]
      .filter(([key]) => !next.has(key))
      .map(([, credential]) => credential)
    this.credentials = next
    if (revoked.length > 0) {
      const keys = new Set(revoked.map(credentialKey))
      for (const [value, session] of this.sessions) {
        if (keys.has(credentialKey(session.credential))) this.sessions.delete(value)
      }
      try {
        await this.record({ event: 'token-rotation-applied', mode: this.mode })
      } catch (error) {
        this.ctx.logger.warn('authentication-local: token revocation access record failed')
        this.ctx.logger.warn(error)
      }
      this.ctx.emit('authentication/revoked', { credentials: revoked })
    }
    this.watcherHealthy = true
    if (recovering) this.ctx.emit('authentication/available')
  }

  private pruneBrowserSessions(): void {
    const now = Date.now()
    for (const [value, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(value)
    }
    while (this.sessions.size >= this.spec.maxBrowserSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
  }
}

export default LocalAuthentication
