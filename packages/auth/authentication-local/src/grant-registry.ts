/** Durable public-key Grants and pending enrollment requests. */
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  authenticationEnrollmentId,
  authenticationGrantId,
  isAuthenticationCapability,
  type AuthenticationCapability,
  type AuthenticationEnrollmentId,
  type AuthenticationGrantId,
} from '@deepseek-ai/dsh-authentication'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { appendAccessRecord, type AccessRecord } from './access-log.ts'
import { assertPrivateFile, isMissing, withPrivateFileLock, writePrivateFile } from './private-files.ts'

const REGISTRY_VERSION = 1
const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60_000
const DEFAULT_MAX_PENDING_ENROLLMENTS = 128
/** Longest pending enrollment lifetime accepted by every local entry point. */
export const MAX_ENROLLMENT_TTL_MS = 15 * 60_000
const MAX_TEMPORARY_GRANT_TTL_MS = 60 * 60_000
const MAX_TEMPORARY_IDLE_TIMEOUT_MS = 15 * 60_000
const MAX_DURABLE_CLOCK_SKEW_MS = 5 * 60_000
const MANAGEMENT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{15}$/
/** Longest invitation lifetime accepted by every local entry point. */
export const MAX_INVITATION_TTL_MS = 7 * 24 * 3600_000
/** Retention of used or expired invitation records before lazy pruning. */
const INVITATION_RETENTION_MS = 7 * 24 * 3600_000
const DEFAULT_MAX_ACTIVE_INVITATIONS = 64
/** Pre-issued approval token: `dshi1_` plus base64url of 20 random bytes. */
const INVITATION_TOKEN_PATTERN = /^dshi1_[A-Za-z0-9_-]{27}$/
const INVITATION_CODE_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TEMPORARY_INVITATION_GRANT_TTL_MS = 60 * 60_000
const TEMPORARY_INVITATION_IDLE_TIMEOUT_MS = 15 * 60_000

/** Approved principal category. */
export type AuthenticationGrantKind = 'device' | 'api-client' | 'temporary'

/** Safe durable metadata for one approved public-key Grant. */
export interface AuthenticationGrant {
  id: AuthenticationGrantId
  name: string
  kind: AuthenticationGrantKind
  revision: number
  publicKey: string
  capabilities: AuthenticationCapability[]
  createdAt: string
  expiresAt?: string
  idleTimeoutMs?: number
  lastUsedAt?: string
}

/** One pending public-key enrollment request. */
export interface EnrollmentRequest {
  id: AuthenticationEnrollmentId
  approvalCode: string
  name: string
  kind: 'device' | 'temporary'
  publicKey: string
  createdAt: string
  expiresAt: string
  state: 'pending'
}

/** Approved enrollment receipt retained for browser polling. */
export interface ApprovedEnrollment {
  id: AuthenticationEnrollmentId
  state: 'approved'
  grantId: AuthenticationGrantId
  grantRevision: number
  capabilities: AuthenticationCapability[]
  expiresAt: string
}

/** Durable state of one enrollment request. */
export type EnrollmentRecord = EnrollmentRequest | ApprovedEnrollment

/** Consumption state of one pre-issued invitation. */
export type InvitationState = 'active' | 'used'

/** Durable pre-issued approval for one future enrollment. */
export interface InvitationRecord {
  id: string
  /** SHA-256 of the invitation token, base64url; the token itself is never stored. */
  codeHash: string
  capabilities: AuthenticationCapability[]
  kind: 'device' | 'temporary'
  createdAt: string
  expiresAt: string
  state: InvitationState
  bindName?: string
  usedAt?: string
  usedByName?: string
}

/** Safe invitation metadata without the code hash. */
export interface InvitationSummary {
  id: string
  kind: 'device' | 'temporary'
  capabilities: AuthenticationCapability[]
  createdAt: string
  expiresAt: string
  state: InvitationState
  bindName?: string
  usedAt?: string
  usedByName?: string
}

/** One freshly issued invitation with its single-use token. */
export interface IssuedEnrollmentInvitation {
  /** Plaintext token, returned exactly once at issuance. */
  token: string
  id: string
  kind: 'device' | 'temporary'
  capabilities: AuthenticationCapability[]
  bindName?: string
  createdAt: string
  expiresAt: string
}

/** Stable client-actionable invitation redemption rejection. */
export class InvitationRedeemError extends Error {
  /** Stable rejection reason projected by the authentication service. */
  readonly reason: 'invalid-invitation' | 'invitation-kind' | 'invitation-name' | 'not-found'
  /**
   * Invitation kind, defined exactly when the reason is `invitation-kind`;
   * every issuing site passes it, so the field stays non-optional for readers.
   */
  readonly expected: 'device' | 'temporary'

  constructor(
    reason: 'invalid-invitation' | 'invitation-kind' | 'invitation-name' | 'not-found',
    expected?: 'device' | 'temporary',
  ) {
    super(`authentication-local: invitation redemption rejected (${reason})`)
    this.name = 'InvitationRedeemError'
    this.reason = reason
    this.expected = expected as 'device' | 'temporary'
  }
}

/** Strict durable Grant registry. */
export interface GrantRegistry {
  version: 1
  instanceId: string
  grants: AuthenticationGrant[]
  enrollments: EnrollmentRecord[]
  invitations: InvitationRecord[]
}

/** Common Grant-registry path and timing options. */
export interface GrantManagementOptions {
  dshHome?: string
  enrollmentTtlMs?: number
  maxPendingEnrollments?: number
  /** Durable bound on unexpired active invitations. */
  maxActiveInvitations?: number
}

/** Pending enrollment capacity rejection with a safe retry delay. */
export class PendingEnrollmentCapacityError extends Error {
  /**
   * @param retryAfterMs - milliseconds until the earliest pending request expires.
   */
  constructor(readonly retryAfterMs: number) {
    super('authentication-local: pending enrollment capacity is full')
    this.name = 'PendingEnrollmentCapacityError'
  }
}

/** Client-actionable enrollment input rejection. */
export class EnrollmentRequestInputError extends Error {
  /**
   * @param reason - stable rejection projected by the authentication service.
   */
  constructor(readonly reason: 'invalid-name' | 'invalid-public-key' | 'name-conflict') {
    super(reason === 'invalid-name'
      ? 'authentication-local: invalid Grant name'
      : reason === 'invalid-public-key'
        ? 'authentication-local: invalid public key'
        : 'authentication-local: Grant or enrollment name already exists')
    this.name = 'EnrollmentRequestInputError'
  }
}

/** Requested enrollment facts accepted from an untrusted browser. */
export interface CreateEnrollmentRequest {
  name: string
  kind: 'device' | 'temporary'
  publicKey: string
}

/** Local or owner-authorized approval policy. */
export interface ApproveEnrollmentOptions {
  capabilities: readonly AuthenticationCapability[]
  expiresInMs?: number
  idleTimeoutMs?: number
}

/**
 * Resolve the public-key Grant registry path.
 * @param dshHome - optional state-root override.
 * @returns the absolute grants.json path.
 */
export function grantRegistryPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'auth', 'grants.json')
}

function legacyTokenRegistryPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'auth', 'tokens.json')
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`authentication-local: ${where} has unexpected fields`)
  }
}

function grantName(value: unknown): string {
  if (typeof value !== 'string'
    || value.trim() !== value
    || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(value)) {
    throw new Error('authentication-local: Grant name must contain 1-64 letters, numbers, spaces, dots, underscores, or hyphens')
  }
  return value
}

function timestamp(value: unknown, where: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`authentication-local: ${where} must be an ISO timestamp`)
  }
  return value
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`authentication-local: ${where} must be a positive integer`)
  }
  return value as number
}

function managementId(): string {
  let value: string
  do value = randomBytes(12).toString('base64url')
  while (value.startsWith('-'))
  return value
}

/**
 * Validate and normalize a P-256 SPKI public key encoded as base64url.
 * @param value - untrusted durable or management input.
 * @returns the validated base64url SPKI value.
 */
export function authenticationPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{80,512}$/.test(value)) {
    throw new Error('authentication-local: public key must be a base64url P-256 SPKI key')
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('wrong key type')
    }
  } catch {
    throw new Error('authentication-local: public key must be a base64url P-256 SPKI key')
  }
  return value
}

function capabilities(value: unknown): AuthenticationCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !isAuthenticationCapability(item))) {
    throw new Error('authentication-local: Grant capabilities must be a non-empty supported list')
  }
  const result = [...new Set(value as AuthenticationCapability[])]
  if (result.length !== value.length) throw new Error('authentication-local: Grant capabilities must not contain duplicates')
  return result
}

function parseGrant(value: unknown, index: number): AuthenticationGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`authentication-local: Grant ${String(index)} must be an object`)
  }
  const object = value as Record<string, unknown>
  const expected = ['id', 'name', 'kind', 'revision', 'publicKey', 'capabilities', 'createdAt']
  for (const optional of ['expiresAt', 'idleTimeoutMs', 'lastUsedAt']) {
    if (object[optional] !== undefined) expected.push(optional)
  }
  strictKeys(object, expected, `Grant ${String(index)}`)
  if (typeof object.id !== 'string' || !MANAGEMENT_ID_PATTERN.test(object.id)) {
    throw new Error(`authentication-local: Grant ${String(index)} has an invalid id`)
  }
  if (object.kind !== 'device' && object.kind !== 'api-client' && object.kind !== 'temporary') {
    throw new Error(`authentication-local: Grant ${String(index)} has an invalid kind`)
  }
  const grantCapabilities = capabilities(object.capabilities)
  if (object.kind === 'temporary' && grantCapabilities.includes('harniverse.authorize')) {
    throw new Error('authentication-local: temporary Grant cannot authorize')
  }
  const grant: AuthenticationGrant = {
    id: authenticationGrantId(object.id),
    name: grantName(object.name),
    kind: object.kind,
    revision: positiveInteger(object.revision, `Grant ${String(index)} revision`),
    publicKey: authenticationPublicKey(object.publicKey),
    capabilities: grantCapabilities,
    createdAt: timestamp(object.createdAt, `Grant ${String(index)} createdAt`),
    ...(object.expiresAt !== undefined && { expiresAt: timestamp(object.expiresAt, `Grant ${String(index)} expiresAt`) }),
    ...(object.idleTimeoutMs !== undefined && { idleTimeoutMs: positiveInteger(object.idleTimeoutMs, `Grant ${String(index)} idleTimeoutMs`) }),
    ...(object.lastUsedAt !== undefined && { lastUsedAt: timestamp(object.lastUsedAt, `Grant ${String(index)} lastUsedAt`) }),
  }
  const createdAt = Date.parse(grant.createdAt)
  const expiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt)
  const lastUsedAt = grant.lastUsedAt === undefined ? undefined : Date.parse(grant.lastUsedAt)
  if (createdAt > Date.now() + MAX_DURABLE_CLOCK_SKEW_MS
    || (lastUsedAt !== undefined && lastUsedAt > Date.now() + MAX_DURABLE_CLOCK_SKEW_MS)) {
    throw new Error(`authentication-local: Grant ${String(index)} timestamp is too far in the future`)
  }
  if (expiresAt !== undefined && expiresAt <= createdAt) {
    throw new Error(`authentication-local: Grant ${String(index)} expiry must follow creation`)
  }
  if (lastUsedAt !== undefined
    && (lastUsedAt < createdAt || (expiresAt !== undefined && lastUsedAt > expiresAt))) {
    throw new Error(`authentication-local: Grant ${String(index)} last use is outside its lifetime`)
  }
  if (grant.kind === 'temporary') {
    if (grant.expiresAt === undefined || grant.idleTimeoutMs === undefined) {
      throw new Error('authentication-local: temporary Grant requires expiry and idle timeout')
    }
    const lifetime = Date.parse(grant.expiresAt) - createdAt
    if (lifetime < 1 || lifetime > MAX_TEMPORARY_GRANT_TTL_MS) {
      throw new Error('authentication-local: temporary Grant lifetime must be positive and cannot exceed 60 minutes')
    }
    if (grant.idleTimeoutMs > MAX_TEMPORARY_IDLE_TIMEOUT_MS) {
      throw new Error('authentication-local: temporary Grant idle timeout cannot exceed 15 minutes')
    }
  }
  return grant
}

function parseEnrollment(value: unknown, index: number): EnrollmentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`authentication-local: enrollment ${String(index)} must be an object`)
  }
  const object = value as Record<string, unknown>
  if (typeof object.id !== 'string' || !MANAGEMENT_ID_PATTERN.test(object.id)) throw new Error(`authentication-local: enrollment ${String(index)} has an invalid id`)
  if (object.state === 'approved') {
    strictKeys(object, ['id', 'state', 'grantId', 'grantRevision', 'capabilities', 'expiresAt'], `enrollment ${String(index)}`)
    if (typeof object.grantId !== 'string' || !MANAGEMENT_ID_PATTERN.test(object.grantId)) throw new Error(`authentication-local: enrollment ${String(index)} has an invalid Grant id`)
    return {
      id: authenticationEnrollmentId(object.id),
      state: 'approved',
      grantId: authenticationGrantId(object.grantId),
      grantRevision: positiveInteger(object.grantRevision, `enrollment ${String(index)} Grant revision`),
      capabilities: capabilities(object.capabilities),
      expiresAt: timestamp(object.expiresAt, `enrollment ${String(index)} expiresAt`),
    }
  }
  strictKeys(object, ['id', 'approvalCode', 'name', 'kind', 'publicKey', 'createdAt', 'expiresAt', 'state'], `enrollment ${String(index)}`)
  if (typeof object.approvalCode !== 'string' || !/^[A-F0-9]{8}$/.test(object.approvalCode)) throw new Error(`authentication-local: enrollment ${String(index)} has an invalid approval code`)
  if (object.kind !== 'device' && object.kind !== 'temporary') throw new Error(`authentication-local: enrollment ${String(index)} has an invalid kind`)
  if (object.state !== 'pending') throw new Error(`authentication-local: enrollment ${String(index)} has an invalid state`)
  return {
    id: authenticationEnrollmentId(object.id),
    approvalCode: object.approvalCode,
    name: grantName(object.name),
    kind: object.kind,
    publicKey: authenticationPublicKey(object.publicKey),
    createdAt: timestamp(object.createdAt, `enrollment ${String(index)} createdAt`),
    expiresAt: timestamp(object.expiresAt, `enrollment ${String(index)} expiresAt`),
    state: 'pending',
  }
}

function parseInvitation(value: unknown, index: number): InvitationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`authentication-local: invitation ${String(index)} must be an object`)
  }
  const object = value as Record<string, unknown>
  const expected = ['id', 'codeHash', 'capabilities', 'kind', 'createdAt', 'expiresAt', 'state']
  for (const optional of ['bindName']) {
    if (object[optional] !== undefined) expected.push(optional)
  }
  // Consumption facts exist only on used records, so strict keys reject them on active ones.
  if (object.state === 'used') expected.push('usedAt', 'usedByName')
  strictKeys(object, expected, `invitation ${String(index)}`)
  if (typeof object.id !== 'string' || !MANAGEMENT_ID_PATTERN.test(object.id)) {
    throw new Error(`authentication-local: invitation ${String(index)} has an invalid id`)
  }
  if (typeof object.codeHash !== 'string' || !INVITATION_CODE_HASH_PATTERN.test(object.codeHash)) {
    throw new Error(`authentication-local: invitation ${String(index)} has an invalid code hash`)
  }
  if (object.kind !== 'device' && object.kind !== 'temporary') {
    throw new Error(`authentication-local: invitation ${String(index)} has an invalid kind`)
  }
  if (object.state !== 'active' && object.state !== 'used') {
    throw new Error(`authentication-local: invitation ${String(index)} has an invalid state`)
  }
  const invitationCapabilities = capabilities(object.capabilities)
  if (object.kind === 'temporary' && invitationCapabilities.includes('harniverse.authorize')) {
    throw new Error('authentication-local: temporary invitation cannot authorize')
  }
  const createdAt = timestamp(object.createdAt, `invitation ${String(index)} createdAt`)
  const expiresAt = timestamp(object.expiresAt, `invitation ${String(index)} expiresAt`)
  if (Date.parse(createdAt) > Date.now() + MAX_DURABLE_CLOCK_SKEW_MS) {
    throw new Error(`authentication-local: invitation ${String(index)} timestamp is too far in the future`)
  }
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error(`authentication-local: invitation ${String(index)} expiry must follow creation`)
  }
  let usedAt: string | undefined
  let usedByName: string | undefined
  if (object.state === 'used') {
    usedAt = timestamp(object.usedAt, `invitation ${String(index)} usedAt`)
    usedByName = grantName(object.usedByName)
    if (Date.parse(usedAt) < Date.parse(createdAt) || Date.parse(usedAt) > Date.parse(expiresAt)) {
      throw new Error(`authentication-local: invitation ${String(index)} use is outside its lifetime`)
    }
  }
  return {
    id: object.id,
    codeHash: object.codeHash,
    capabilities: invitationCapabilities,
    kind: object.kind,
    createdAt,
    expiresAt,
    state: object.state,
    ...(object.bindName !== undefined && { bindName: grantName(object.bindName) }),
    ...(usedAt !== undefined && { usedAt }),
    ...(usedByName !== undefined && { usedByName }),
  }
}

/**
 * Parse one untrusted grants.json document.
 * @param text - complete JSON document.
 * @returns the strictly validated Grant registry.
 */
export function parseGrantRegistry(text: string): GrantRegistry {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('authentication-local: Grant registry must be an object')
  const object = value as Record<string, unknown>
  strictKeys(object, object.invitations === undefined
    ? ['version', 'instanceId', 'grants', 'enrollments']
    : ['version', 'instanceId', 'grants', 'enrollments', 'invitations'], 'Grant registry')
  if (object.version !== REGISTRY_VERSION) throw new Error('authentication-local: unsupported Grant registry version')
  if (typeof object.instanceId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(object.instanceId)) throw new Error('authentication-local: Grant registry has an invalid instance id')
  if (!Array.isArray(object.grants) || !Array.isArray(object.enrollments)) throw new Error('authentication-local: Grant registry lists are invalid')
  if (object.invitations !== undefined && !Array.isArray(object.invitations)) throw new Error('authentication-local: Grant registry lists are invalid')
  const registry: GrantRegistry = {
    version: REGISTRY_VERSION,
    instanceId: object.instanceId,
    grants: object.grants.map(parseGrant),
    enrollments: object.enrollments.map(parseEnrollment),
    invitations: object.invitations === undefined ? [] : object.invitations.map(parseInvitation),
  }
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const item of [...registry.grants, ...registry.enrollments]) {
    if ('name' in item && names.has(item.name)) throw new Error(`authentication-local: duplicate Grant name "${item.name}"`)
    if (ids.has(item.id)) throw new Error('authentication-local: duplicate Grant or enrollment id')
    if ('name' in item) names.add(item.name)
    ids.add(item.id)
  }
  const invitationIds = new Set<string>()
  const codeHashes = new Set<string>()
  for (const invitation of registry.invitations) {
    if (invitationIds.has(invitation.id) || codeHashes.has(invitation.codeHash)) {
      throw new Error('authentication-local: duplicate invitation id or code hash')
    }
    invitationIds.add(invitation.id)
    codeHashes.add(invitation.codeHash)
  }
  return registry
}

async function rejectLegacyRegistry(dshHome?: string): Promise<void> {
  const path = legacyTokenRegistryPath(dshHome)
  await assertPrivateFile(path)
  try {
    await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  throw new Error(`authentication-local: legacy ${path} is unsupported; remove it and enroll a public-key device`)
}

function emptyRegistry(): GrantRegistry {
  return {
    version: REGISTRY_VERSION,
    instanceId: randomBytes(16).toString('base64url'),
    grants: [],
    enrollments: [],
    invitations: [],
  }
}

async function readRegistry(path: string): Promise<GrantRegistry | undefined> {
  await assertPrivateFile(path)
  try {
    return parseGrantRegistry(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function writeRegistry(path: string, registry: GrantRegistry): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(registry, null, 2)}\n`)
}

/**
 * Read the registry, creating its stable instance id on first use.
 * @param options - state-root, audit, and enrollment policy overrides.
 * @returns the current strictly validated registry.
 */
export async function readGrantRegistry(options: GrantManagementOptions = {}): Promise<GrantRegistry> {
  await rejectLegacyRegistry(options.dshHome)
  const path = grantRegistryPath(options.dshHome)
  return withPrivateFileLock(path, async () => {
    const current = await readRegistry(path)
    if (current !== undefined) return current
    const created = emptyRegistry()
    await writeRegistry(path, created)
    return created
  })
}

async function mutateRegistry<T>(
  options: GrantManagementOptions,
  operation: (registry: GrantRegistry) => { registry: GrantRegistry; result: T; accessRecord: AccessRecord },
): Promise<T> {
  await rejectLegacyRegistry(options.dshHome)
  const path = grantRegistryPath(options.dshHome)
  return withPrivateFileLock(path, async () => {
    const current = await readRegistry(path) ?? emptyRegistry()
    const mutation = operation(current)
    await writeRegistry(path, mutation.registry)
    try {
      await appendAccessRecord(mutation.accessRecord, options)
    } catch (error) {
      try {
        await writeRegistry(path, current)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'authentication-local: audit failed and Grant registry rollback was incomplete')
      }
      throw error
    }
    return mutation.result
  })
}

/**
 * Create a short-lived enrollment request without granting API authority.
 * @param request - device metadata and P-256 public key.
 * @param options - state-root, audit, and enrollment policy overrides.
 * @returns the committed pending enrollment.
 */
export async function createEnrollmentRequest(
  request: CreateEnrollmentRequest,
  options: GrantManagementOptions = {},
): Promise<EnrollmentRequest> {
  let name: string
  try {
    name = grantName(request.name)
  } catch {
    throw new EnrollmentRequestInputError('invalid-name')
  }
  let publicKey: string
  try {
    publicKey = authenticationPublicKey(request.publicKey)
  } catch {
    throw new EnrollmentRequestInputError('invalid-public-key')
  }
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  const ttl = options.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new RangeError('authentication-local: enrollmentTtlMs must be a positive integer')
  if (ttl > MAX_ENROLLMENT_TTL_MS) throw new RangeError('authentication-local: enrollmentTtlMs cannot exceed 15 minutes')
  const maxPendingEnrollments = options.maxPendingEnrollments ?? DEFAULT_MAX_PENDING_ENROLLMENTS
  if (!Number.isSafeInteger(maxPendingEnrollments) || maxPendingEnrollments < 1) {
    throw new RangeError('authentication-local: maxPendingEnrollments must be a positive integer')
  }
  const enrollment: EnrollmentRequest = {
    id: authenticationEnrollmentId(managementId()),
    approvalCode: randomBytes(4).toString('hex').toUpperCase(),
    name,
    kind: request.kind,
    publicKey,
    createdAt,
    expiresAt: new Date(now + ttl).toISOString(),
    state: 'pending',
  }
  return await mutateRegistry(options, (registry) => {
    const unexpired = registry.enrollments.filter(item => Date.parse(item.expiresAt) > now)
    // One browser key holds at most one pending request: its newer enrollment
    // supersedes the older one atomically, freeing that name for the retry.
    const superseded = new Set(unexpired.filter((item): item is EnrollmentRequest =>
      item.state === 'pending' && item.publicKey === publicKey).map(item => item.id))
    const enrollments = unexpired.filter(item => !superseded.has(item.id))
    if (registry.grants.some(item => item.name === name) || enrollments.some(item => 'name' in item && item.name === name)) {
      throw new EnrollmentRequestInputError('name-conflict')
    }
    const pending = enrollments.filter(item => item.state === 'pending')
    if (pending.length >= maxPendingEnrollments) {
      const earliestExpiry = Math.min(...pending.map(item => Date.parse(item.expiresAt)))
      throw new PendingEnrollmentCapacityError(Math.max(1, earliestExpiry - now))
    }
    return {
      registry: { ...registry, enrollments: [...enrollments, enrollment] },
      result: enrollment,
      accessRecord: {
        time: createdAt,
        event: 'enrollment-requested',
        channel: 'browser-enrollment',
        grantName: name,
        ...(superseded.size > 0 && { reasonCode: 'superseded' }),
      },
    }
  })
}

/**
 * Test one invitation token against the strict issued format.
 * @param value - untrusted browser-submitted token.
 * @returns whether the value is shaped like an issued invitation.
 */
export function isInvitationToken(value: string): boolean {
  return INVITATION_TOKEN_PATTERN.test(value)
}

function invitationCodeHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

/**
 * Drop invitation records whose consumption or expiry is older than the retention window.
 * @param invitations - retained registry invitations.
 * @param now - comparison instant in epoch milliseconds.
 * @returns the invitations worth keeping durable.
 */
function retainedInvitations(invitations: readonly InvitationRecord[], now: number): InvitationRecord[] {
  return invitations.filter((invitation) => {
    const settledAt = Date.parse(invitation.usedAt ?? invitation.expiresAt)
    return settledAt + INVITATION_RETENTION_MS > now
  })
}

/**
 * Issue one pre-issued approval for a future enrollment.
 * @param input - capabilities, kind, optional device-name binding, and required lifetime.
 * @param options - state-root, audit, and invitation capacity overrides.
 * @returns the invitation with its plaintext token, returned exactly once.
 */
export async function issueEnrollmentInvitation(
  input: { capabilities: readonly AuthenticationCapability[]; kind: 'device' | 'temporary'; bindName?: string; ttlMs: number },
  options: GrantManagementOptions = {},
): Promise<IssuedEnrollmentInvitation> {
  const invitationCapabilities = capabilities(input.capabilities)
  if (input.kind === 'temporary' && invitationCapabilities.includes('harniverse.authorize')) {
    throw new Error('authentication-local: temporary invitation cannot authorize')
  }
  const bindName = input.bindName === undefined ? undefined : grantName(input.bindName)
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
    throw new RangeError('authentication-local: ttlMs must be a positive integer')
  }
  if (input.ttlMs > MAX_INVITATION_TTL_MS) throw new RangeError('authentication-local: ttlMs cannot exceed 7 days')
  const maxActiveInvitations = options.maxActiveInvitations ?? DEFAULT_MAX_ACTIVE_INVITATIONS
  if (!Number.isSafeInteger(maxActiveInvitations) || maxActiveInvitations < 1) {
    throw new RangeError('authentication-local: maxActiveInvitations must be a positive integer')
  }
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  return mutateRegistry(options, (registry) => {
    requireOwnerBootstrap(registry, invitationCapabilities, now)
    const retained = retainedInvitations(registry.invitations, now)
    const active = retained.filter(invitation => invitation.state === 'active' && Date.parse(invitation.expiresAt) > now)
    if (active.length >= maxActiveInvitations) {
      throw new Error('authentication-local: active invitation capacity is full')
    }
    const takenHashes = new Set(retained.map(invitation => invitation.codeHash))
    let token = ''
    while (token === '' || takenHashes.has(invitationCodeHash(token))) {
      token = `dshi1_${randomBytes(20).toString('base64url')}`
    }
    const invitation: InvitationRecord = {
      id: managementId(),
      codeHash: invitationCodeHash(token),
      capabilities: invitationCapabilities,
      kind: input.kind,
      createdAt,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      state: 'active',
      ...(bindName !== undefined && { bindName }),
    }
    return {
      registry: { ...registry, invitations: [...retained, invitation] },
      result: {
        token,
        id: invitation.id,
        kind: invitation.kind,
        capabilities: invitation.capabilities,
        createdAt,
        expiresAt: invitation.expiresAt,
        ...(bindName !== undefined && { bindName }),
      },
      accessRecord: { time: createdAt, event: 'invitation-issued', channel: 'local-cli' },
    }
  })
}

/**
 * List retained invitation metadata without code hashes.
 * @param options - state-root and private-file options.
 * @returns current invitations in creation order.
 */
export async function listEnrollmentInvitations(options: GrantManagementOptions = {}): Promise<InvitationSummary[]> {
  const invitations = (await readGrantRegistry(options)).invitations
  return invitations.map(({ codeHash: _codeHash, ...summary }) => summary)
}

/**
 * Revoke one retained invitation by opaque id.
 * @param id - exact invitation id.
 * @param options - state-root and mandatory audit options.
 */
export function revokeEnrollmentInvitation(id: string, options: GrantManagementOptions = {}): Promise<void> {
  const time = new Date().toISOString()
  return mutateRegistry(options, (registry) => {
    if (!registry.invitations.some(invitation => invitation.id === id)) {
      throw new Error('authentication invitation does not exist')
    }
    return {
      registry: { ...registry, invitations: registry.invitations.filter(invitation => invitation.id !== id) },
      result: undefined,
      accessRecord: { time, event: 'invitation-revoked', channel: 'local-cli' },
    }
  })
}

/**
 * Redeem one pre-issued invitation against a pending enrollment, approving it.
 * @param enrollmentId - exact pending enrollment id from the same browser key.
 * @param token - one-time invitation token; possession acts as the approval.
 * @param options - state-root, audit, and receipt policy overrides.
 * @returns the approved enrollment receipt.
 */
export async function redeemEnrollmentInvitation(
  enrollmentId: string,
  token: string,
  options: GrantManagementOptions = {},
): Promise<ApprovedEnrollment> {
  if (!isInvitationToken(token)) throw new InvitationRedeemError('invalid-invitation')
  const codeHash = invitationCodeHash(token)
  const receiptTtl = options.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS
  if (!Number.isSafeInteger(receiptTtl) || receiptTtl < 1 || receiptTtl > MAX_ENROLLMENT_TTL_MS) {
    throw new RangeError('authentication-local: enrollmentTtlMs must be between 1 millisecond and 15 minutes')
  }
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  return mutateRegistry(options, (registry) => {
    const retained = retainedInvitations(registry.invitations, now)
    const request = registry.enrollments.find((item): item is EnrollmentRequest =>
      item.id === enrollmentId && item.state === 'pending' && Date.parse(item.expiresAt) > now)
    if (request === undefined) throw new InvitationRedeemError('not-found')
    const invitation = retained.find(item => item.codeHash === codeHash)
    if (invitation === undefined || invitation.state === 'used' || Date.parse(invitation.expiresAt) <= now) {
      throw new InvitationRedeemError('invalid-invitation')
    }
    if (invitation.kind !== request.kind) throw new InvitationRedeemError('invitation-kind', invitation.kind)
    if (invitation.bindName !== undefined && invitation.bindName !== request.name) {
      throw new InvitationRedeemError('invitation-name')
    }
    requireOwnerBootstrap(registry, invitation.capabilities, now)
    const grant: AuthenticationGrant = {
      id: authenticationGrantId(managementId()),
      name: request.name,
      kind: request.kind,
      revision: 1,
      publicKey: request.publicKey,
      capabilities: invitation.capabilities,
      createdAt,
      ...(request.kind === 'temporary' && {
        expiresAt: new Date(now + TEMPORARY_INVITATION_GRANT_TTL_MS).toISOString(),
        idleTimeoutMs: TEMPORARY_INVITATION_IDLE_TIMEOUT_MS,
        lastUsedAt: createdAt,
      }),
    }
    const receipt: ApprovedEnrollment = {
      id: request.id,
      state: 'approved',
      grantId: grant.id,
      grantRevision: grant.revision,
      capabilities: grant.capabilities,
      expiresAt: new Date(now + receiptTtl).toISOString(),
    }
    return {
      registry: {
        ...registry,
        grants: [...registry.grants, grant],
        enrollments: registry.enrollments.map(item => item.id === enrollmentId ? receipt : item),
        invitations: retained.map(item => item.id === invitation.id
          ? { ...item, state: 'used' as const, usedAt: createdAt, usedByName: request.name }
          : item),
      },
      result: receipt,
      accessRecord: { time: createdAt, event: 'invitation-redeemed', channel: 'browser-enrollment', grantName: grant.name },
    }
  })
}

/**
 * List unexpired pending requests in creation order.
 * @param options - state-root and private-file options.
 * @returns the current unexpired pending requests.
 */
export async function listEnrollmentRequests(options: GrantManagementOptions = {}): Promise<EnrollmentRequest[]> {
  const now = Date.now()
  return (await readGrantRegistry(options)).enrollments.filter((item): item is EnrollmentRequest => item.state === 'pending' && Date.parse(item.expiresAt) > now)
}

/**
 * Read one unexpired enrollment state by opaque id.
 * @param id - exact enrollment request id.
 * @param options - state-root and private-file options.
 * @returns the pending or approved record, or `undefined` after expiry/removal.
 */
export async function getEnrollmentStatus(
  id: AuthenticationEnrollmentId,
  options: GrantManagementOptions = {},
): Promise<EnrollmentRecord | undefined> {
  const record = (await readGrantRegistry(options)).enrollments.find(item => item.id === id)
  return record !== undefined && Date.parse(record.expiresAt) > Date.now() ? record : undefined
}

/**
 * Approve one pending request into a capability-limited Grant.
 * @param enrollmentId - exact pending enrollment id.
 * @param approval - capabilities and optional lifetime restrictions.
 * @param options - state-root and mandatory audit options.
 * @returns the committed Grant.
 */
export function approveEnrollmentRequest(
  enrollmentId: string,
  approval: ApproveEnrollmentOptions,
  options: GrantManagementOptions = {},
): Promise<AuthenticationGrant> {
  const approvedCapabilities = capabilities(approval.capabilities)
  if (approval.expiresInMs !== undefined && (!Number.isSafeInteger(approval.expiresInMs) || approval.expiresInMs < 1)) throw new RangeError('authentication-local: expiresInMs must be a positive integer')
  if (approval.idleTimeoutMs !== undefined && (!Number.isSafeInteger(approval.idleTimeoutMs) || approval.idleTimeoutMs < 1)) throw new RangeError('authentication-local: idleTimeoutMs must be a positive integer')
  const receiptTtl = options.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS
  if (!Number.isSafeInteger(receiptTtl) || receiptTtl < 1 || receiptTtl > MAX_ENROLLMENT_TTL_MS) {
    throw new RangeError('authentication-local: enrollmentTtlMs must be between 1 millisecond and 15 minutes')
  }
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  return mutateRegistry(options, (registry) => {
    const request = registry.enrollments.find((item): item is EnrollmentRequest => item.id === enrollmentId && item.state === 'pending')
    if (request === undefined || Date.parse(request.expiresAt) <= now) throw new Error('authentication enrollment request does not exist or has expired')
    requireOwnerBootstrap(registry, approvedCapabilities, now)
    if (request.kind === 'temporary') {
      if (approvedCapabilities.includes('harniverse.authorize')) throw new Error('authentication-local: temporary Grant cannot authorize')
      if (approval.expiresInMs === undefined || approval.idleTimeoutMs === undefined) throw new Error('authentication-local: temporary Grant requires expiry and idle timeout')
      if (approval.expiresInMs > MAX_TEMPORARY_GRANT_TTL_MS) throw new Error('authentication-local: temporary Grant cannot exceed 60 minutes')
      if (approval.idleTimeoutMs > MAX_TEMPORARY_IDLE_TIMEOUT_MS) throw new Error('authentication-local: temporary Grant idle timeout cannot exceed 15 minutes')
    }
    const grant: AuthenticationGrant = {
      id: authenticationGrantId(managementId()),
      name: request.name,
      kind: request.kind,
      revision: 1,
      publicKey: request.publicKey,
      capabilities: approvedCapabilities,
      createdAt,
      ...(approval.expiresInMs !== undefined && { expiresAt: new Date(now + approval.expiresInMs).toISOString() }),
      ...(approval.idleTimeoutMs !== undefined && { idleTimeoutMs: approval.idleTimeoutMs, lastUsedAt: createdAt }),
    }
    return {
      registry: {
        ...registry,
        grants: [...registry.grants, grant],
        enrollments: registry.enrollments.map(item => item.id === enrollmentId ? {
          id: request.id,
          state: 'approved' as const,
          grantId: grant.id,
          grantRevision: grant.revision,
          capabilities: grant.capabilities,
          expiresAt: new Date(now + receiptTtl).toISOString(),
        } : item),
      },
      result: grant,
      accessRecord: { time: createdAt, event: 'grant-approved', channel: 'local-cli', grantName: grant.name },
    }
  })
}

/**
 * List safe Grant metadata in stable name order.
 * @param options - state-root and private-file options.
 * @returns current Grants sorted by name.
 */
export async function listAuthenticationGrants(options: GrantManagementOptions = {}): Promise<AuthenticationGrant[]> {
  return [...(await readGrantRegistry(options)).grants].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Register one automation public key directly from local owner authority.
 * @param input - client label, P-256 public key, authority, and optional expiry.
 * @param options - state-root and mandatory audit options.
 * @returns the committed API-client Grant.
 */
export async function createAuthenticationClientGrant(
  input: { name: string; publicKey: string; capabilities: readonly AuthenticationCapability[]; expiresInMs?: number },
  options: GrantManagementOptions = {},
): Promise<AuthenticationGrant> {
  const name = grantName(input.name)
  const publicKey = authenticationPublicKey(input.publicKey)
  const clientCapabilities = capabilities(input.capabilities)
  if (input.expiresInMs !== undefined && (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs < 1)) {
    throw new RangeError('authentication-local: expiresInMs must be a positive integer')
  }
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  return await mutateRegistry(options, (registry) => {
    requireOwnerBootstrap(registry, clientCapabilities, now)
    if (registry.grants.some(item => item.name === name)
      || registry.enrollments.some(item => 'name' in item && item.name === name)) {
      throw new Error(`authentication Grant or enrollment "${name}" already exists`)
    }
    const grant: AuthenticationGrant = {
      id: authenticationGrantId(managementId()),
      name,
      kind: 'api-client',
      revision: 1,
      publicKey,
      capabilities: clientCapabilities,
      createdAt,
      ...(input.expiresInMs !== undefined && { expiresAt: new Date(now + input.expiresInMs).toISOString() }),
    }
    return {
      registry: { ...registry, grants: [...registry.grants, grant] },
      result: grant,
      accessRecord: { time: createdAt, event: 'grant-approved', channel: 'local-cli', grantName: grant.name },
    }
  })
}

/**
 * Test expiry and temporary-device idle timeout at one instant.
 * @param grant - Grant to inspect.
 * @param now - comparison instant in epoch milliseconds.
 * @returns whether the Grant may exchange a credential.
 */
export function isAuthenticationGrantActive(grant: AuthenticationGrant, now = Date.now()): boolean {
  return authenticationGrantDeadline(grant) > now
}

/**
 * Compute the earliest absolute or idle deadline for one Grant.
 * @param grant - Grant whose current lifetime bounds are inspected.
 * @returns epoch milliseconds, or positive infinity for an unbounded Grant.
 */
export function authenticationGrantDeadline(grant: AuthenticationGrant): number {
  const absolute = grant.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(grant.expiresAt)
  const idle = grant.idleTimeoutMs === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(grant.lastUsedAt ?? grant.createdAt) + grant.idleTimeoutMs
  return Math.min(absolute, idle)
}

function requireOwnerBootstrap(
  registry: GrantRegistry,
  nextCapabilities: readonly AuthenticationCapability[],
  now: number,
): void {
  const hasOwner = registry.grants.some(grant =>
    isAuthenticationGrantActive(grant, now) && grant.capabilities.includes('harniverse.authorize'))
  if (!hasOwner && !nextCapabilities.includes('harniverse.authorize')) {
    throw new Error('authentication-local: first active Grant must authorize')
  }
}

/**
 * Atomically validate one exact Grant revision and record exchange activity.
 * @param grantId - exact Grant id from the consumed challenge.
 * @param grantRevision - exact Grant revision from the consumed challenge.
 * @param options - state-root and mandatory audit options.
 * @returns the current active Grant, or `undefined` when invalid.
 */
export function consumeAuthenticationGrant(
  grantId: AuthenticationGrantId,
  grantRevision: number,
  options: GrantManagementOptions = {},
): Promise<AuthenticationGrant | undefined> {
  const now = Date.now()
  const time = new Date(now).toISOString()
  return mutateRegistry(options, (registry) => {
    const index = registry.grants.findIndex(item => item.id === grantId && item.revision === grantRevision)
    const current = registry.grants[index]
    if (current === undefined || !isAuthenticationGrantActive(current, now)) {
      return {
        registry,
        result: undefined,
        accessRecord: { time, event: 'challenge-exchange-rejected', channel: 'token-exchange', reasonCode: 'invalid-grant' },
      }
    }
    const grant = current.idleTimeoutMs === undefined ? current : { ...current, lastUsedAt: time }
    const grants = [...registry.grants]
    grants[index] = grant
    return {
      registry: { ...registry, grants },
      result: grant,
      accessRecord: { time, event: 'challenge-exchange-accepted', channel: 'token-exchange', grantName: grant.name },
    }
  })
}

/**
 * Revoke one exact Grant by opaque id.
 * @param grantId - exact Grant id.
 * @param options - state-root and mandatory audit options.
 */
export function revokeAuthenticationGrant(grantId: AuthenticationGrantId, options: GrantManagementOptions = {}): Promise<void> {
  const time = new Date().toISOString()
  return mutateRegistry(options, (registry) => {
    const grant = registry.grants.find(item => item.id === grantId)
    if (grant === undefined) throw new Error('authentication Grant does not exist')
    return {
      registry: { ...registry, grants: registry.grants.filter(item => item.id !== grantId) },
      result: undefined,
      accessRecord: { time, event: 'grant-revoked', channel: 'local-cli', grantName: grant.name },
    }
  })
}
