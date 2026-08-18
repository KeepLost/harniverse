/** Durable public-key Grants and pending enrollment requests. */
import { createPublicKey, randomBytes } from 'node:crypto'
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

/** Strict durable Grant registry. */
export interface GrantRegistry {
  version: 1
  instanceId: string
  grants: AuthenticationGrant[]
  enrollments: EnrollmentRecord[]
}

/** Common Grant-registry path and timing options. */
export interface GrantManagementOptions {
  dshHome?: string
  enrollmentTtlMs?: number
  maxPendingEnrollments?: number
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
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('authentication-local: Grant name must match ^[a-z0-9][a-z0-9._-]{0,63}$')
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

/**
 * Parse one untrusted grants.json document.
 * @param text - complete JSON document.
 * @returns the strictly validated Grant registry.
 */
export function parseGrantRegistry(text: string): GrantRegistry {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('authentication-local: Grant registry must be an object')
  const object = value as Record<string, unknown>
  strictKeys(object, ['version', 'instanceId', 'grants', 'enrollments'], 'Grant registry')
  if (object.version !== REGISTRY_VERSION) throw new Error('authentication-local: unsupported Grant registry version')
  if (typeof object.instanceId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(object.instanceId)) throw new Error('authentication-local: Grant registry has an invalid instance id')
  if (!Array.isArray(object.grants) || !Array.isArray(object.enrollments)) throw new Error('authentication-local: Grant registry lists are invalid')
  const registry: GrantRegistry = {
    version: REGISTRY_VERSION,
    instanceId: object.instanceId,
    grants: object.grants.map(parseGrant),
    enrollments: object.enrollments.map(parseEnrollment),
  }
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const item of [...registry.grants, ...registry.enrollments]) {
    if ('name' in item && names.has(item.name)) throw new Error(`authentication-local: duplicate Grant name "${item.name}"`)
    if (ids.has(item.id)) throw new Error('authentication-local: duplicate Grant or enrollment id')
    if ('name' in item) names.add(item.name)
    ids.add(item.id)
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
  return { version: REGISTRY_VERSION, instanceId: randomBytes(16).toString('base64url'), grants: [], enrollments: [] }
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
  const name = grantName(request.name)
  const publicKey = authenticationPublicKey(request.publicKey)
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
    const enrollments = registry.enrollments.filter(item => Date.parse(item.expiresAt) > now)
    if (registry.grants.some(item => item.name === name) || enrollments.some(item => 'name' in item && item.name === name)) {
      throw new Error(`authentication Grant or enrollment "${name}" already exists`)
    }
    const pending = enrollments.filter(item => item.state === 'pending')
    if (pending.length >= maxPendingEnrollments) {
      const earliestExpiry = Math.min(...pending.map(item => Date.parse(item.expiresAt)))
      throw new PendingEnrollmentCapacityError(Math.max(1, earliestExpiry - now))
    }
    return {
      registry: { ...registry, enrollments: [...enrollments, enrollment] },
      result: enrollment,
      accessRecord: { time: createdAt, event: 'enrollment-requested', channel: 'browser-enrollment', grantName: name },
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
