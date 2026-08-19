/** Local public-key Grant provider for inbound network authentication. */
import { randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  InboundAuthentication,
  type AuthenticationAccessToken,
  type AuthenticationCapability,
  type AuthenticationAttempt,
  type AuthenticationChallenge,
  type AuthenticationChallengeProof,
  type AuthenticationChallengePurpose,
  type AuthenticationDecision,
  type AuthenticationEnrollmentId,
  type AuthenticationEnrollmentDecision,
  type AuthenticationEnrollmentInput,
  type AuthenticationEnrollmentStatus,
  type AuthenticationEnrollmentApproval,
  type AuthenticationGrantDecision,
  type AuthenticationGrantId,
  type AuthenticationGrantRevision,
  type AuthenticationGrantSummary,
  type AuthenticationMode,
  type AuthenticationPrincipal,
  type AuthenticationStatus,
  type BrowserAuthenticationDecision,
} from '@deepseek-ai/dsh-authentication'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { AccessTokenLedger } from './access-tokens.ts'
import { appendAccessRecord, type AccessRecord } from './access-log.ts'
import { ChallengeLedger } from './challenges.ts'
import {
  approveEnrollmentRequest,
  authenticationGrantDeadline,
  consumeAuthenticationGrant,
  createEnrollmentRequest,
  EnrollmentRequestInputError,
  getEnrollmentStatus,
  grantRegistryPath,
  isAuthenticationGrantActive,
  listAuthenticationGrants,
  listEnrollmentRequests,
  MAX_ENROLLMENT_TTL_MS,
  PendingEnrollmentCapacityError,
  readGrantRegistry,
  revokeAuthenticationGrant,
  type AuthenticationGrant,
  type GrantRegistry,
} from './grant-registry.ts'
import { acquireAuthenticationLease } from './instance-lease.ts'

export * from './grant-registry.ts'

function grantSummary(grant: AuthenticationGrant): AuthenticationGrantSummary {
  return {
    id: grant.id,
    name: grant.name,
    kind: grant.kind,
    revision: grant.revision,
    capabilities: grant.capabilities,
    createdAt: grant.createdAt,
    ...(grant.expiresAt !== undefined && { expiresAt: grant.expiresAt }),
    ...(grant.idleTimeoutMs !== undefined && { idleTimeoutMs: grant.idleTimeoutMs }),
    ...(grant.lastUsedAt !== undefined && { lastUsedAt: grant.lastUsedAt }),
  }
}

/** Local authentication plugin configuration. */
export interface Config {
  /** State root containing the private authentication registry and access log. */
  dshHome?: string
  /** Authenticated network admission or loopback-only development bypass. */
  mode?: AuthenticationMode
  /** Whether to watch the durable Grant registry for cross-process changes. */
  watch?: boolean
  /** Filesystem watcher debounce interval in milliseconds. */
  debounceMs?: number
  /** Access Token and browser-session lifetime in milliseconds, at most 15 minutes. */
  accessTokenTtlMs?: number
  /** Single-use possession challenge lifetime in milliseconds, at most 5 minutes. */
  challengeTtlMs?: number
  /** Pending enrollment request lifetime in milliseconds, at most 15 minutes. */
  enrollmentTtlMs?: number
  /** Maximum unexpired pending enrollment records in the durable registry. */
  maxPendingEnrollments?: number
  /** Enrollment requests allowed from one direct peer in each counting window. */
  enrollmentRequestLimit?: number
  /** Enrollment request counting window in milliseconds. */
  enrollmentRequestWindowMs?: number
  /** Maximum direct-peer enrollment counters retained in process memory. */
  maxEnrollmentPeerKeys?: number
  /** Maximum process-memory Access Token records. */
  maxAccessTokens?: number
  /** Maximum process-memory Access Tokens issued by one exact Grant revision. */
  maxAccessTokensPerGrant?: number
  /** Maximum process-memory challenge records. */
  maxChallenges?: number
  /** Maximum process-memory challenges issued by one exact Grant revision. */
  maxChallengesPerGrant?: number
  /** Maximum concurrent process-memory browser sessions. */
  maxBrowserSessions?: number
  /** Maximum concurrent browser sessions issued by one exact Grant revision. */
  maxBrowserSessionsPerGrant?: number
  /** Fail-closed durable registry reconciliation interval in milliseconds. */
  reconcileIntervalMs?: number
  /** Active access-log size before rotation in bytes. */
  accessLogMaxBytes?: number
  /** Number of rotated access-log files retained. */
  accessLogMaxFiles?: number
  /** Invalid credential attempts allowed within one rate-limit window. */
  authFailureLimit?: number
  /** Authentication failure counting window in milliseconds. */
  authFailureWindowMs?: number
  /** Rate-limit block duration in milliseconds. */
  authFailureBlockMs?: number
  /** Maximum peer-and-channel rate-limit records retained. */
  maxAuthFailureKeys?: number
}

interface ResolvedSpec {
  dshHome?: string
  mode: AuthenticationMode
  watch: boolean
  debounceMs: number
  accessTokenTtlMs: number
  challengeTtlMs: number
  enrollmentTtlMs: number
  maxPendingEnrollments: number
  enrollmentRequestLimit: number
  enrollmentRequestWindowMs: number
  maxEnrollmentPeerKeys: number
  maxAccessTokens: number
  maxAccessTokensPerGrant: number
  maxChallenges: number
  maxChallengesPerGrant: number
  maxBrowserSessions: number
  maxBrowserSessionsPerGrant: number
  reconcileIntervalMs: number
  accessLogMaxBytes: number
  accessLogMaxFiles: number
  authFailureLimit: number
  authFailureWindowMs: number
  authFailureBlockMs: number
  maxAuthFailureKeys: number
}

interface BrowserSession {
  principal: Extract<AuthenticationPrincipal, { kind: 'grant' }>
  expiresAt: number
}

interface AuthenticationFailures {
  failures: number
  windowStartedAt: number
  blockedUntil: number
}

interface EnrollmentRequests {
  requests: number
  windowStartedAt: number
}

/** Stable Cordis service name. */
export const name = 'authentication-local'

const MAX_ACCESS_TOKEN_TTL_MS = 15 * 60_000
const MAX_CHALLENGE_TTL_MS = 5 * 60_000

const BYPASS_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'bypass',
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
}

/**
 * Resolve configurable timing and capacity defaults.
 * @param config - partial plugin configuration.
 * @returns complete runtime values for the Provider.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const accessTokenTtlMs = boundedLifetime(
    'accessTokenTtlMs', config.accessTokenTtlMs ?? 10 * 60_000, MAX_ACCESS_TOKEN_TTL_MS, '15 minutes',
  )
  const challengeTtlMs = boundedLifetime(
    'challengeTtlMs', config.challengeTtlMs ?? 60_000, MAX_CHALLENGE_TTL_MS, '5 minutes',
  )
  const enrollmentTtlMs = boundedLifetime(
    'enrollmentTtlMs', config.enrollmentTtlMs ?? 10 * 60_000, MAX_ENROLLMENT_TTL_MS, '15 minutes',
  )
  const maxAccessTokens = positiveConfig('maxAccessTokens', config.maxAccessTokens ?? 4_096)
  const maxChallenges = positiveConfig('maxChallenges', config.maxChallenges ?? 4_096)
  const maxBrowserSessions = positiveConfig('maxBrowserSessions', config.maxBrowserSessions ?? 1_024)
  return {
    ...(config.dshHome !== undefined && { dshHome: config.dshHome }),
    mode: config.mode ?? 'authenticated',
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
    accessTokenTtlMs,
    challengeTtlMs,
    enrollmentTtlMs,
    maxPendingEnrollments: positiveConfig('maxPendingEnrollments', config.maxPendingEnrollments ?? 128),
    enrollmentRequestLimit: positiveConfig('enrollmentRequestLimit', config.enrollmentRequestLimit ?? 5),
    enrollmentRequestWindowMs: positiveConfig('enrollmentRequestWindowMs', config.enrollmentRequestWindowMs ?? 60_000),
    maxEnrollmentPeerKeys: positiveConfig('maxEnrollmentPeerKeys', config.maxEnrollmentPeerKeys ?? 4_096),
    maxAccessTokens,
    maxAccessTokensPerGrant: config.maxAccessTokensPerGrant === undefined
      ? Math.min(64, maxAccessTokens)
      : perGrantCapacity('maxAccessTokensPerGrant', config.maxAccessTokensPerGrant, maxAccessTokens),
    maxChallenges,
    maxChallengesPerGrant: config.maxChallengesPerGrant === undefined
      ? Math.min(16, maxChallenges)
      : perGrantCapacity('maxChallengesPerGrant', config.maxChallengesPerGrant, maxChallenges),
    maxBrowserSessions,
    maxBrowserSessionsPerGrant: config.maxBrowserSessionsPerGrant === undefined
      ? Math.min(16, maxBrowserSessions)
      : perGrantCapacity('maxBrowserSessionsPerGrant', config.maxBrowserSessionsPerGrant, maxBrowserSessions),
    reconcileIntervalMs: config.reconcileIntervalMs ?? 5_000,
    accessLogMaxBytes: config.accessLogMaxBytes ?? 10 * 1024 * 1024,
    accessLogMaxFiles: config.accessLogMaxFiles ?? 5,
    authFailureLimit: config.authFailureLimit ?? 10,
    authFailureWindowMs: config.authFailureWindowMs ?? 60_000,
    authFailureBlockMs: config.authFailureBlockMs ?? 5 * 60_000,
    maxAuthFailureKeys: config.maxAuthFailureKeys ?? 4_096,
  }
}

function boundedLifetime(name: string, value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`authentication-local: ${name} must be a positive integer`)
  }
  if (value > maximum) throw new RangeError(`authentication-local: ${name} cannot exceed ${label}`)
  return value
}

function positiveConfig(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`authentication-local: ${name} must be a positive integer`)
  }
  return value
}

function perGrantCapacity(name: string, value: number, total: number): number {
  const resolved = positiveConfig(name, value)
  if (resolved > total) throw new RangeError(`authentication-local: ${name} cannot exceed its global capacity`)
  return resolved
}

function grantKey(value: AuthenticationGrant | AuthenticationGrantRevision): string {
  const grantId = 'id' in value ? value.id : value.grantId
  const revision = 'revision' in value ? value.revision : value.grantRevision
  return `${grantId}:${String(revision)}`
}

/** Public-key Grant provider with process-local credentials and durable access records. */
export class LocalAuthentication extends InboundAuthentication {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    mode: z.union([z.const('authenticated'), z.const('bypass')]).default('authenticated'),
    watch: z.boolean().default(true),
    debounceMs: z.natural().default(100),
    accessTokenTtlMs: z.natural().min(1).max(MAX_ACCESS_TOKEN_TTL_MS).default(10 * 60_000),
    challengeTtlMs: z.natural().min(1).max(MAX_CHALLENGE_TTL_MS).default(60_000),
    enrollmentTtlMs: z.natural().min(1).max(MAX_ENROLLMENT_TTL_MS).default(10 * 60_000),
    maxPendingEnrollments: z.natural().min(1).default(128),
    enrollmentRequestLimit: z.natural().min(1).default(5),
    enrollmentRequestWindowMs: z.natural().min(1).default(60_000),
    maxEnrollmentPeerKeys: z.natural().min(1).default(4_096),
    maxAccessTokens: z.natural().min(1).default(4_096),
    maxAccessTokensPerGrant: z.natural().min(1),
    maxChallenges: z.natural().min(1).default(4_096),
    maxChallengesPerGrant: z.natural().min(1),
    maxBrowserSessions: z.natural().min(1).default(1_024),
    maxBrowserSessionsPerGrant: z.natural().min(1),
    reconcileIntervalMs: z.natural().min(1).default(5_000),
    accessLogMaxBytes: z.natural().min(1).default(10 * 1024 * 1024),
    accessLogMaxFiles: z.natural().min(1).default(5),
    authFailureLimit: z.natural().min(1).default(10),
    authFailureWindowMs: z.natural().min(1).default(60_000),
    authFailureBlockMs: z.natural().min(1).default(5 * 60_000),
    maxAuthFailureKeys: z.natural().min(1).default(4_096),
  })

  readonly mode: AuthenticationMode
  private readonly spec: ResolvedSpec
  private readonly accessTokens: AccessTokenLedger
  private readonly challenges: ChallengeLedger
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly authenticationFailures = new Map<string, AuthenticationFailures>()
  private readonly enrollmentRequests = new Map<string, EnrollmentRequests>()
  private grants = new Map<string, AuthenticationGrant>()
  private operations: Promise<void> = Promise.resolve()
  private watcherHealthy = true
  private ownerAvailable = false
  private ownerExpiry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.mode = this.spec.mode
    this.accessTokens = new AccessTokenLedger({
      ttlMs: this.spec.accessTokenTtlMs,
      maxTokens: this.spec.maxAccessTokens,
      maxTokensPerGrant: this.spec.maxAccessTokensPerGrant,
    })
    this.challenges = new ChallengeLedger({
      ttlMs: this.spec.challengeTtlMs,
      maxChallenges: this.spec.maxChallenges,
      maxChallengesPerGrant: this.spec.maxChallengesPerGrant,
    })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const lease = await acquireAuthenticationLease({
      ...(this.spec.dshHome !== undefined && { dshHome: this.spec.dshHome }),
      mode: this.mode,
    })
    yield async () => {
      this.closed = true
      if (this.ownerExpiry !== undefined) clearTimeout(this.ownerExpiry)
      this.accessTokens.clear()
      this.challenges.clear()
      this.sessions.clear()
      await this.operations
      try {
        await this.record({ event: 'instance-stopped', mode: this.mode })
      } finally {
        await lease.release()
      }
    }

    const registry = await readGrantRegistry(this.spec)
    this.installRegistry(registry)
    await this.record({ event: 'instance-started', mode: this.mode })
    const reconciliation = setInterval(() => { this.queueRefresh() }, this.spec.reconcileIntervalMs)
    reconciliation.unref()
    if (!this.spec.watch) {
      yield async () => {
        this.closed = true
        clearInterval(reconciliation)
        await this.operations
      }
      return
    }

    const path = grantRegistryPath(this.spec.dshHome)
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
      this.ctx.logger.warn('authentication-local: Grant registry watcher failed')
      this.ctx.logger.warn(error)
      this.queueWatcherFailure()
    })
    yield async () => {
      this.closed = true
      clearInterval(reconciliation)
      await watcher.close()
      await this.operations
    }
  }

  override async status(): Promise<AuthenticationStatus> {
    if (this.mode === 'bypass') return { mode: this.mode, sealed: false }
    const registry = await readGrantRegistry(this.spec)
    return {
      mode: this.mode,
      sealed: !registry.grants.some(grant =>
        isAuthenticationGrantActive(grant) && grant.capabilities.includes('harniverse.authorize')),
    }
  }

  override async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationDecision> {
    return this.enqueue(async () => {
      let decision: AuthenticationDecision
      if (this.mode === 'bypass') decision = { kind: 'accepted', principal: BYPASS_PRINCIPAL }
      else if (!this.watcherHealthy || !this.ownerAvailable) decision = { kind: 'rejected', reason: 'authentication-unavailable' }
      else {
        try {
          const key = this.failureKey(attempt.channel, attempt.peerAddress)
          decision = this.rateLimited(key) ?? await this.decide(attempt)
          if (decision.kind === 'accepted') this.authenticationFailures.delete(key)
          else if (decision.reason === 'invalid-credential') this.recordAuthenticationFailure(key)
        } catch (error) {
          this.ctx.logger.warn('authentication-local: Grant verification unavailable')
          this.ctx.logger.warn(error)
          decision = { kind: 'rejected', reason: 'authentication-unavailable' }
        }
      }
      try {
        const admittedGrant = decision.kind === 'accepted' && decision.principal.kind === 'grant'
          ? this.grantFor(decision.principal)
          : undefined
        await this.record({
          event: decision.kind === 'accepted' ? 'access-accepted' : 'access-rejected',
          mode: this.mode,
          channel: attempt.channel,
          outcome: decision.kind === 'accepted' ? 'accepted' : 'rejected',
          ...(attempt.peerAddress !== undefined && { peer: attempt.peerAddress }),
          ...(admittedGrant !== undefined && { grantName: admittedGrant.name }),
          ...(decision.kind === 'rejected' && { reasonCode: decision.reason }),
        })
      } catch (error) {
        this.ctx.logger.warn('authentication-local: access record failed')
        this.ctx.logger.warn(error)
        if (decision.kind === 'accepted') return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return decision
    })
  }

  override async requestEnrollment(
    input: AuthenticationEnrollmentInput,
    peerAddress?: string,
  ): Promise<AuthenticationEnrollmentDecision> {
    if (this.mode === 'bypass' || !this.watcherHealthy) {
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    const retryAfterMs = this.limitEnrollmentRequest(peerAddress)
    if (retryAfterMs !== undefined) return { kind: 'rejected', reason: 'rate-limited', retryAfterMs }
    try {
      const request = await createEnrollmentRequest(input, this.spec)
      return {
        kind: 'accepted',
        value: {
          state: 'pending',
          id: request.id,
          approvalCode: request.approvalCode,
          name: request.name,
          kind: request.kind,
          expiresAt: request.expiresAt,
        },
      }
    } catch (error) {
      if (error instanceof PendingEnrollmentCapacityError) {
        return { kind: 'rejected', reason: 'rate-limited', retryAfterMs: error.retryAfterMs }
      }
      if (error instanceof EnrollmentRequestInputError) return { kind: 'rejected', reason: error.reason }
      throw error
    }
  }

  override async enrollmentStatus(id: AuthenticationEnrollmentId): Promise<AuthenticationEnrollmentStatus | undefined> {
    const status = await getEnrollmentStatus(id, this.spec)
    if (status === undefined) return undefined
    if (status.state === 'approved') return status
    return {
      state: 'pending',
      id: status.id,
      approvalCode: status.approvalCode,
      name: status.name,
      kind: status.kind,
      expiresAt: status.expiresAt,
    }
  }

  override async listPendingEnrollments(): Promise<readonly Extract<AuthenticationEnrollmentStatus, { state: 'pending' }>[]> {
    return (await listEnrollmentRequests(this.spec)).map(request => ({
      state: 'pending',
      id: request.id,
      approvalCode: request.approvalCode,
      name: request.name,
      kind: request.kind,
      expiresAt: request.expiresAt,
    }))
  }

  override async approveEnrollment(
    id: AuthenticationEnrollmentId,
    approval: AuthenticationEnrollmentApproval,
  ): Promise<AuthenticationGrantSummary> {
    const grant = await approveEnrollmentRequest(id, approval, this.spec)
    await this.refresh()
    return grantSummary(grant)
  }

  override async listGrants(): Promise<readonly AuthenticationGrantSummary[]> {
    return (await listAuthenticationGrants(this.spec)).map(grantSummary)
  }

  override async revokeGrant(id: AuthenticationGrantId): Promise<void> {
    await revokeAuthenticationGrant(id, this.spec)
    await this.refresh()
  }

  override async createChallenge(
    grantId: AuthenticationGrantId,
    purpose: AuthenticationChallengePurpose,
  ): Promise<AuthenticationGrantDecision<AuthenticationChallenge>> {
    if (this.mode === 'bypass' || !this.watcherHealthy) {
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    try {
      const registry = await readGrantRegistry(this.spec)
      if (!this.hasActiveOwner(registry)) {
        this.setOwnerAvailable(false)
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      if (!this.ownerAvailable) {
        this.ownerAvailable = true
        this.scheduleOwnerExpiry(registry)
        this.ctx.emit('authentication/available')
      }
      const grant = registry.grants.find(item => item.id === grantId)
      if (grant === undefined || !isAuthenticationGrantActive(grant)) return { kind: 'rejected', reason: 'invalid-grant' }
      const challenge = this.challenges.issue(registry.instanceId, grant, purpose)
      if (challenge === undefined) {
        await this.record({
          event: 'challenge-rejected', mode: this.mode, channel: 'token-exchange', outcome: 'rejected',
          grantName: grant.name, reasonCode: 'capacity',
        })
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      try {
        await this.record({ event: 'challenge-issued', mode: this.mode, channel: 'token-exchange', grantName: grant.name })
      } catch (error) {
        this.challenges.discard(challenge.id)
        throw error
      }
      return { kind: 'accepted', value: challenge }
    } catch (error) {
      this.ctx.logger.warn('authentication-local: challenge issue unavailable')
      this.ctx.logger.warn(error)
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
  }

  override async exchangeAccessToken(
    proof: AuthenticationChallengeProof,
    peerAddress?: string,
  ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>> {
    const exchanged = await this.consumeProof(proof, 'access-token', peerAddress)
    if (exchanged.kind === 'rejected') return exchanged
    const token = this.accessTokens.issue(exchanged.value)
    if (token === undefined) {
      await this.recordCapacityRejection(exchanged.value.name)
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    return { kind: 'accepted', value: token }
  }

  override async issueEmergencyAccessToken(
    issuer: AuthenticationPrincipal,
    capabilities: readonly AuthenticationCapability[],
    ttlMs: number,
  ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>> {
    if (!this.watcherHealthy || !this.ownerAvailable) return { kind: 'rejected', reason: 'authentication-unavailable' }
    if (issuer.kind !== 'grant' || !issuer.capabilities.includes('harniverse.authorize')) {
      return { kind: 'rejected', reason: 'invalid-grant' }
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 15 * 60_000
      || capabilities.length === 0
      || capabilities.includes('harniverse.authorize')
      || capabilities.some(capability => !issuer.capabilities.includes(capability))) {
      return { kind: 'rejected', reason: 'invalid-grant' }
    }
    try {
      const registry = await readGrantRegistry(this.spec)
      const grant = registry.grants.find(item => item.id === issuer.grantId && item.revision === issuer.grantRevision)
      if (grant === undefined || !isAuthenticationGrantActive(grant)) return { kind: 'rejected', reason: 'invalid-grant' }
      const token = this.accessTokens.issueRestricted(grant, capabilities, ttlMs)
      if (token === undefined) {
        await this.recordCapacityRejection(grant.name)
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return { kind: 'accepted', value: token }
    } catch {
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
  }

  override async createBrowserSession(
    proof: AuthenticationChallengeProof,
    peerAddress?: string,
  ): Promise<BrowserAuthenticationDecision> {
    if (this.mode === 'bypass') return { kind: 'rejected', reason: 'authentication-unavailable' }
    const key = this.failureKey('browser-login', peerAddress)
    const limited = this.rateLimited(key)
    if (limited !== undefined) {
      if (!await this.recordLogin('rejected', peerAddress, undefined, limited.reason)) {
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return limited
    }
    const exchanged = await this.consumeProof(proof, 'browser-session', peerAddress)
    if (exchanged.kind === 'rejected') {
      if (exchanged.reason === 'invalid-proof') this.recordAuthenticationFailure(key)
      if (!await this.recordLogin('rejected', peerAddress, undefined, exchanged.reason)) {
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return {
        kind: 'rejected',
        reason: exchanged.reason === 'authentication-unavailable' ? 'authentication-unavailable' : 'invalid-credential',
      }
    }
    this.authenticationFailures.delete(key)
    const grant = exchanged.value
    const expiresAt = Math.min(Date.now() + this.spec.accessTokenTtlMs, authenticationGrantDeadline(grant))
    const principal: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
      kind: 'grant',
      grantId: grant.id,
      name: grant.name,
      grantRevision: grant.revision,
      capabilities: [...grant.capabilities],
      expiresAt: new Date(expiresAt).toISOString(),
    }
    const evict = this.browserSessionEviction(grant)
    if (evict === false) {
      if (!await this.recordLogin('rejected', peerAddress, grant, 'capacity')) {
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    if (!await this.recordLogin('accepted', peerAddress, grant)) {
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    const value = randomBytes(32).toString('base64url')
    if (evict !== undefined) this.sessions.delete(evict)
    this.sessions.set(value, { principal, expiresAt })
    return { kind: 'accepted', session: { value, expiresAt: principal.expiresAt, principal } }
  }

  override revokeBrowserSession(value?: string): void {
    if (value !== undefined) this.sessions.delete(value)
  }

  private async decide(attempt: AuthenticationAttempt): Promise<AuthenticationDecision> {
    if (attempt.authorization !== undefined) {
      const match = /^Bearer ([^\s]+)$/.exec(attempt.authorization)
      const value = match?.[1]
      if (value === undefined) return { kind: 'rejected', reason: 'invalid-credential' }
      const principal = this.accessTokens.authenticate(value)
      if (principal === undefined) return { kind: 'rejected', reason: 'invalid-credential' }
      if (!await this.principalActive(principal)) {
        return { kind: 'rejected', reason: this.ownerAvailable ? 'invalid-credential' : 'authentication-unavailable' }
      }
      return { kind: 'accepted', principal }
    }
    const value = attempt.browserSession
    if (value === undefined) return { kind: 'rejected', reason: 'missing-credential' }
    const session = this.sessions.get(value)
    if (session === undefined) return { kind: 'rejected', reason: 'invalid-credential' }
    if (session.expiresAt <= Date.now() || !await this.principalActive(session.principal)) {
      this.sessions.delete(value)
      return { kind: 'rejected', reason: this.ownerAvailable ? 'invalid-credential' : 'authentication-unavailable' }
    }
    return { kind: 'accepted', principal: session.principal }
  }

  private async consumeProof(
    proof: AuthenticationChallengeProof,
    purpose: AuthenticationChallengePurpose,
    peerAddress?: string,
  ): Promise<AuthenticationGrantDecision<AuthenticationGrant>> {
    if (!this.watcherHealthy) return { kind: 'rejected', reason: 'authentication-unavailable' }
    try {
      const registry = await readGrantRegistry(this.spec)
      if (!this.hasActiveOwner(registry)) {
        this.setOwnerAvailable(false)
        return { kind: 'rejected', reason: 'authentication-unavailable' }
      }
      if (!this.ownerAvailable) {
        this.ownerAvailable = true
        this.scheduleOwnerExpiry(registry)
        this.ctx.emit('authentication/available')
      }
    } catch (error) {
      this.ctx.logger.warn('authentication-local: owner verification unavailable')
      this.ctx.logger.warn(error)
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
    const consumed = this.challenges.consume(proof)
    if (consumed.kind === 'rejected') return consumed
    if (consumed.purpose !== purpose) return { kind: 'rejected', reason: 'invalid-proof' }
    try {
      const grant = await consumeAuthenticationGrant(consumed.grantId, consumed.grantRevision, this.spec)
      if (grant === undefined) return { kind: 'rejected', reason: 'invalid-grant' }
      this.grants.set(grantKey(grant), grant)
      if (peerAddress !== undefined) {
        await this.record({
          event: 'challenge-exchange-accepted',
          mode: this.mode,
          channel: 'token-exchange',
          peer: peerAddress,
          grantName: grant.name,
        })
      }
      return { kind: 'accepted', value: grant }
    } catch (error) {
      this.ctx.logger.warn('authentication-local: challenge exchange unavailable')
      this.ctx.logger.warn(error)
      return { kind: 'rejected', reason: 'authentication-unavailable' }
    }
  }

  private async principalActive(principal: Extract<AuthenticationPrincipal, { kind: 'grant' }>): Promise<boolean> {
    if (Date.parse(principal.expiresAt) <= Date.now()) return false
    const registry = await readGrantRegistry(this.spec)
    if (!this.hasActiveOwner(registry)) {
      this.setOwnerAvailable(false)
      return false
    }
    const grant = registry.grants.find(item => item.id === principal.grantId && item.revision === principal.grantRevision)
    if (grant !== undefined && isAuthenticationGrantActive(grant)) {
      this.grants.set(grantKey(grant), grant)
      return true
    }
    this.accessTokens.revoke(principal.grantId, principal.grantRevision)
    this.challenges.revoke(principal.grantId, principal.grantRevision)
    return false
  }

  private grantFor(principal: Extract<AuthenticationPrincipal, { kind: 'grant' }>): AuthenticationGrant | undefined {
    return this.grants.get(grantKey({ grantId: principal.grantId, grantRevision: principal.grantRevision }))
  }

  private failureKey(channel: AuthenticationAttempt['channel'] | 'browser-login', peerAddress: string | undefined): string {
    return `${channel}:${peerAddress ?? 'unknown'}`
  }

  private rateLimited(key: string): Extract<AuthenticationDecision, { kind: 'rejected' }> | undefined {
    const state = this.authenticationFailures.get(key)
    if (state === undefined) return undefined
    const now = Date.now()
    if (state.blockedUntil > now) return { kind: 'rejected', reason: 'rate-limited', retryAfterMs: state.blockedUntil - now }
    if (now - state.windowStartedAt >= this.spec.authFailureWindowMs) this.authenticationFailures.delete(key)
    return undefined
  }

  private recordAuthenticationFailure(key: string): void {
    const now = Date.now()
    let state = this.authenticationFailures.get(key)
    if (state === undefined) {
      while (this.authenticationFailures.size >= this.spec.maxAuthFailureKeys) {
        const oldest = this.authenticationFailures.keys().next().value
        if (oldest === undefined) break
        this.authenticationFailures.delete(oldest)
      }
      state = { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      this.authenticationFailures.set(key, state)
    }
    state.failures += 1
    if (state.failures >= this.spec.authFailureLimit) state.blockedUntil = now + this.spec.authFailureBlockMs
  }

  private limitEnrollmentRequest(peerAddress: string | undefined): number | undefined {
    const key = peerAddress ?? 'unknown'
    const now = Date.now()
    let state = this.enrollmentRequests.get(key)
    if (state !== undefined && now - state.windowStartedAt >= this.spec.enrollmentRequestWindowMs) {
      this.enrollmentRequests.delete(key)
      state = undefined
    }
    if (state !== undefined && state.requests >= this.spec.enrollmentRequestLimit) {
      return Math.max(1, state.windowStartedAt + this.spec.enrollmentRequestWindowMs - now)
    }
    if (state === undefined) {
      while (this.enrollmentRequests.size >= this.spec.maxEnrollmentPeerKeys) {
        const oldest = this.enrollmentRequests.keys().next().value
        if (oldest === undefined) break
        this.enrollmentRequests.delete(oldest)
      }
      state = { requests: 0, windowStartedAt: now }
      this.enrollmentRequests.set(key, state)
    }
    state.requests += 1
    return undefined
  }

  private record(record: Omit<AccessRecord, 'time'> & { time?: string }): Promise<void> {
    return appendAccessRecord({ time: record.time ?? new Date().toISOString(), ...record }, {
      ...(this.spec.dshHome !== undefined && { dshHome: this.spec.dshHome }),
      maxBytes: this.spec.accessLogMaxBytes,
      maxFiles: this.spec.accessLogMaxFiles,
    })
  }

  private async recordLogin(
    outcome: 'accepted' | 'rejected',
    peer: string | undefined,
    grant?: AuthenticationGrant,
    reasonCode?: string,
  ): Promise<boolean> {
    try {
      await this.record({
        event: outcome === 'accepted' ? 'browser-login-accepted' : 'browser-login-rejected',
        mode: this.mode,
        channel: 'browser-login',
        outcome,
        ...(peer !== undefined && { peer }),
        ...(grant !== undefined && { grantName: grant.name }),
        ...(reasonCode !== undefined && { reasonCode }),
      })
      return true
    } catch (error) {
      this.ctx.logger.warn('authentication-local: browser login record failed')
      this.ctx.logger.warn(error)
      return false
    }
  }

  private async recordCapacityRejection(grantName: string): Promise<void> {
    try {
      await this.record({
        event: 'access-rejected',
        mode: this.mode,
        channel: 'token-exchange',
        outcome: 'rejected',
        grantName,
        reasonCode: 'capacity',
      })
    } catch (error) {
      this.ctx.logger.warn('authentication-local: capacity rejection record failed')
      this.ctx.logger.warn(error)
    }
  }

  private queueRefresh(): void {
    if (this.closed) return
    const task = this.enqueue(async () => {
      try {
        await this.refresh()
      } catch (error) {
        this.ctx.logger.warn('authentication-local: Grant registry reload failed; keeping the last good registry')
        this.ctx.logger.warn(error)
        this.markAuthenticationUnavailable()
      }
    })
    void task.catch((error: unknown) => {
      this.ctx.logger.warn('authentication-local: Grant refresh failure containment failed')
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
    const wasAvailable = this.ownerAvailable
    this.watcherHealthy = false
    this.clearProcessCredentials()
    if (wasAvailable) this.ctx.emit('authentication/unavailable')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private installRegistry(registry: GrantRegistry): void {
    this.grants = new Map(registry.grants.map(grant => [grantKey(grant), grant]))
    this.ownerAvailable = this.mode === 'bypass' || this.hasActiveOwner(registry)
    this.scheduleOwnerExpiry(registry)
  }

  private async refresh(): Promise<void> {
    if (this.closed) return
    const wasAvailable = this.watcherHealthy && this.ownerAvailable
    const registry = await readGrantRegistry(this.spec)
    const next = new Map(registry.grants.map(grant => [grantKey(grant), grant]))
    const revoked = [...this.grants]
      .filter(([key]) => !next.has(key))
      .map(([, grant]): AuthenticationGrantRevision => ({ grantId: grant.id, grantRevision: grant.revision }))
    this.grants = next
    this.watcherHealthy = true
    this.ownerAvailable = this.mode === 'bypass' || this.hasActiveOwner(registry)
    if (!this.ownerAvailable) this.clearProcessCredentials()
    this.scheduleOwnerExpiry(registry)
    const available = this.ownerAvailable
    if (revoked.length > 0) {
      const keys = new Set(revoked.map(grantKey))
      for (const revision of revoked) {
        this.accessTokens.revoke(revision.grantId, revision.grantRevision)
        this.challenges.revoke(revision.grantId, revision.grantRevision)
      }
      for (const [value, session] of this.sessions) {
        if (keys.has(grantKey({ grantId: session.principal.grantId, grantRevision: session.principal.grantRevision }))) {
          this.sessions.delete(value)
        }
      }
      this.ctx.emit('authentication/revoked', { grants: revoked })
    }
    if (wasAvailable !== available) this.ctx.emit(available ? 'authentication/available' : 'authentication/unavailable')
    if (revoked.length > 0) {
      try {
        await this.record({ event: 'grant-revision-applied', mode: this.mode })
      } catch (error) {
        this.ctx.logger.warn('authentication-local: Grant revocation access record failed')
        this.ctx.logger.warn(error)
      }
    }
  }

  private hasActiveOwner(registry: GrantRegistry, now = Date.now()): boolean {
    return registry.grants.some(grant =>
      grant.capabilities.includes('harniverse.authorize') && isAuthenticationGrantActive(grant, now))
  }

  private setOwnerAvailable(available: boolean): void {
    if (this.ownerAvailable === available) return
    const wasAvailable = this.watcherHealthy && this.ownerAvailable
    this.ownerAvailable = available
    if (!available) {
      if (this.ownerExpiry !== undefined) clearTimeout(this.ownerExpiry)
      this.ownerExpiry = undefined
      this.clearProcessCredentials()
    }
    const nextAvailable = this.watcherHealthy && this.ownerAvailable
    if (wasAvailable !== nextAvailable) {
      this.ctx.emit(nextAvailable ? 'authentication/available' : 'authentication/unavailable')
    }
  }

  private clearProcessCredentials(): void {
    this.sessions.clear()
    this.accessTokens.clear()
    this.challenges.clear()
  }

  private scheduleOwnerExpiry(registry: GrantRegistry): void {
    if (this.ownerExpiry !== undefined) clearTimeout(this.ownerExpiry)
    this.ownerExpiry = undefined
    if (this.closed || this.mode === 'bypass' || !this.ownerAvailable) return
    const now = Date.now()
    const deadline = Math.min(...registry.grants
      .filter(grant => grant.capabilities.includes('harniverse.authorize') && isAuthenticationGrantActive(grant, now))
      .map(authenticationGrantDeadline))
    if (!Number.isFinite(deadline)) return
    this.ownerExpiry = setTimeout(() => {
      this.ownerExpiry = undefined
      this.queueRefresh()
    }, Math.min(Math.max(1, deadline - now), 2_147_483_647))
    this.ownerExpiry.unref()
  }

  private browserSessionEviction(grant: AuthenticationGrant): string | undefined | false {
    const now = Date.now()
    for (const [value, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(value)
    const own = [...this.sessions]
      .filter(([, session]) => session.principal.grantId === grant.id && session.principal.grantRevision === grant.revision)
      .map(([value]) => value)
    if (own.length >= this.spec.maxBrowserSessionsPerGrant) return own[0]
    return this.sessions.size >= this.spec.maxBrowserSessions ? false : undefined
  }
}

export default LocalAuthentication
