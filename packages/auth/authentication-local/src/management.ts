/** Named authentication token registry and local CLI management operations. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  authenticationTokenId,
  authenticationTokenName,
  type AuthenticationCredential,
  type AuthenticationTokenId,
  type AuthenticationTokenName,
} from '@deepseek-ai/dsh-authentication'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { appendAccessRecord, type AccessRecord } from './access-log.ts'
import { assertPrivateFile, isMissing, withPrivateFileLock, writePrivateFile } from './private-files.ts'

const REGISTRY_VERSION = 1
const TOKEN_PREFIX = 'dsh1'

interface TokenRecord {
  id: AuthenticationTokenId
  name: AuthenticationTokenName
  generation: number
  digest: string
  createdAt: string
  rotatedAt?: string
}

interface TokenRegistry {
  version: 1
  tokens: TokenRecord[]
}

/** Common token-registry path selection. */
export interface AuthenticationManagementOptions {
  dshHome?: string
}

/** Safe token metadata returned by list. */
export interface AuthenticationTokenInfo {
  name: AuthenticationTokenName
  createdAt: string
  rotatedAt?: string
}

/** Newly generated secret shown once by add and reset. */
export interface GeneratedAuthenticationToken extends AuthenticationTokenInfo {
  token: string
}

/**
 * Resolve the named-token registry path.
 * @param dshHome - explicit Harness home, or the process default.
 * @returns the token registry path.
 */
export function authenticationTokenRegistryPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'auth', 'tokens.json')
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`authentication-local: ${where} has unexpected fields`)
  }
}

function parseRecord(value: unknown, index: number): TokenRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`authentication-local: token registry entry ${String(index)} must be an object`)
  }
  const object = value as Record<string, unknown>
  const expected = object.rotatedAt === undefined
    ? ['id', 'name', 'generation', 'digest', 'createdAt']
    : ['id', 'name', 'generation', 'digest', 'createdAt', 'rotatedAt']
  strictKeys(object, expected, `token registry entry ${String(index)}`)
  if (typeof object.id !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(object.id)) throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid id`)
  if (typeof object.name !== 'string') throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid name`)
  if (!Number.isSafeInteger(object.generation) || (object.generation as number) < 1) throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid generation`)
  if (typeof object.digest !== 'string' || !/^[a-f0-9]{64}$/.test(object.digest)) throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid digest`)
  if (typeof object.createdAt !== 'string' || Number.isNaN(Date.parse(object.createdAt))) throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid createdAt`)
  if (object.rotatedAt !== undefined && (typeof object.rotatedAt !== 'string' || Number.isNaN(Date.parse(object.rotatedAt)))) throw new Error(`authentication-local: token registry entry ${String(index)} has an invalid rotatedAt`)
  return {
    id: authenticationTokenId(object.id),
    name: authenticationTokenName(object.name),
    generation: object.generation as number,
    digest: object.digest,
    createdAt: object.createdAt,
    ...(object.rotatedAt !== undefined && { rotatedAt: object.rotatedAt }),
  }
}

/**
 * Parse and validate an untrusted token registry document.
 * @param text - complete registry JSON text.
 * @returns the validated registry.
 */
export function parseAuthenticationTokenRegistry(text: string): TokenRegistry {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('authentication-local: token registry must be an object')
  }
  const object = value as Record<string, unknown>
  strictKeys(object, ['version', 'tokens'], 'token registry')
  if (object.version !== REGISTRY_VERSION) throw new Error('authentication-local: unsupported token registry version')
  if (!Array.isArray(object.tokens)) throw new Error('authentication-local: token registry tokens must be an array')
  const tokens = object.tokens.map(parseRecord)
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const token of tokens) {
    if (names.has(token.name)) throw new Error(`authentication-local: duplicate token name "${token.name}"`)
    if (ids.has(token.id)) throw new Error('authentication-local: duplicate token id')
    names.add(token.name)
    ids.add(token.id)
  }
  return { version: REGISTRY_VERSION, tokens }
}

async function readRegistry(path: string): Promise<TokenRegistry> {
  await assertPrivateFile(path)
  try {
    return parseAuthenticationTokenRegistry(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return { version: REGISTRY_VERSION, tokens: [] }
    throw error
  }
}

/**
 * Read the current registry; absence is an empty registry.
 * @param options - Harness home selection.
 * @returns the validated current registry.
 */
export async function readAuthenticationTokenRegistry(options: AuthenticationManagementOptions = {}): Promise<TokenRegistry> {
  const path = authenticationTokenRegistryPath(options.dshHome)
  return withPrivateFileLock(path, () => readRegistry(path))
}

function secretDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function generateToken(): { id: AuthenticationTokenId; secret: string; token: string } {
  const id = authenticationTokenId(randomBytes(12).toString('base64url'))
  const secret = randomBytes(32).toString('base64url')
  return { id, secret, token: `${TOKEN_PREFIX}_${id}_${secret}` }
}

function parseToken(value: string): { id: string; secret: string } | undefined {
  const match = /^dsh1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(value)
  if (match === null) return undefined
  const id = match[1]
  const secret = match[2]
  return id === undefined || secret === undefined ? undefined : { id, secret }
}

async function writeRegistry(path: string, registry: TokenRegistry): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(registry, null, 2)}\n`)
}

async function mutateRegistry<T>(
  options: AuthenticationManagementOptions,
  operation: (registry: TokenRegistry) => { registry: TokenRegistry; result: T; accessRecord: AccessRecord },
): Promise<T> {
  const path = authenticationTokenRegistryPath(options.dshHome)
  return withPrivateFileLock(path, async () => {
    const current = await readRegistry(path)
    const mutation = operation(current)
    await writeRegistry(path, mutation.registry)
    try {
      await appendAccessRecord(mutation.accessRecord, options)
    } catch (error) {
      try {
        await writeRegistry(path, current)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'authentication-local: audit failed and token registry rollback was incomplete')
      }
      throw error
    }
    return mutation.result
  })
}

/**
 * Add a unique named token and return its secret exactly once.
 * @param name - unique token management name.
 * @param options - Harness home selection.
 * @returns safe metadata plus the newly generated token.
 */
export async function addAuthenticationToken(
  name: string,
  options: AuthenticationManagementOptions = {},
): Promise<GeneratedAuthenticationToken> {
  const tokenName = authenticationTokenName(name)
  const generated = generateToken()
  const createdAt = new Date().toISOString()
  const result = await mutateRegistry(options, (registry) => {
    if (registry.tokens.some(token => token.name === tokenName)) {
      throw new Error(`authentication token "${tokenName}" already exists`)
    }
    const record: TokenRecord = {
      id: generated.id,
      name: tokenName,
      generation: 1,
      digest: secretDigest(generated.secret),
      createdAt,
    }
    return {
      registry: { ...registry, tokens: [...registry.tokens, record] },
      result: { name: tokenName, token: generated.token, createdAt },
      accessRecord: { time: createdAt, event: 'token-added', channel: 'local-cli', tokenName },
    }
  })
  return result
}

/**
 * Rotate one existing named token without affecting any peer token.
 * @param name - existing token management name.
 * @param options - Harness home selection.
 * @returns safe metadata plus the replacement token.
 */
export async function resetAuthenticationToken(
  name: string,
  options: AuthenticationManagementOptions = {},
): Promise<GeneratedAuthenticationToken> {
  const tokenName = authenticationTokenName(name)
  const secret = randomBytes(32).toString('base64url')
  const rotatedAt = new Date().toISOString()
  const result = await mutateRegistry(options, (registry) => {
    const index = registry.tokens.findIndex(token => token.name === tokenName)
    if (index === -1) throw new Error(`authentication token "${tokenName}" does not exist`)
    const previous = registry.tokens[index]
    if (previous === undefined) throw new Error('authentication-local: token registry index disappeared during reset')
    const replacement: TokenRecord = {
      ...previous,
      generation: previous.generation + 1,
      digest: secretDigest(secret),
      rotatedAt,
    }
    const tokens = [...registry.tokens]
    tokens[index] = replacement
    return {
      registry: { ...registry, tokens },
      result: { name: tokenName, token: `${TOKEN_PREFIX}_${previous.id}_${secret}`, createdAt: previous.createdAt, rotatedAt },
      accessRecord: { time: rotatedAt, event: 'token-reset', channel: 'local-cli', tokenName },
    }
  })
  return result
}

/**
 * Delete one existing named token.
 * @param name - existing token management name.
 * @param options - Harness home selection.
 */
export async function deleteAuthenticationToken(name: string, options: AuthenticationManagementOptions = {}): Promise<void> {
  const tokenName = authenticationTokenName(name)
  const time = new Date().toISOString()
  await mutateRegistry(options, (registry) => {
    if (!registry.tokens.some(token => token.name === tokenName)) throw new Error(`authentication token "${tokenName}" does not exist`)
    return {
      registry: { ...registry, tokens: registry.tokens.filter(token => token.name !== tokenName) },
      result: undefined,
      accessRecord: { time, event: 'token-deleted', channel: 'local-cli', tokenName },
    }
  })
}

/**
 * List safe token metadata in stable name order.
 * @param options - Harness home selection.
 * @returns token names and timestamps without credential material.
 */
export async function listAuthenticationTokens(options: AuthenticationManagementOptions = {}): Promise<AuthenticationTokenInfo[]> {
  const registry = await readAuthenticationTokenRegistry(options)
  return registry.tokens
    .map(token => ({
      name: token.name,
      createdAt: token.createdAt,
      ...(token.rotatedAt !== undefined && { rotatedAt: token.rotatedAt }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Verify one bearer token against the current durable registry.
 * @param value - raw Bearer token value.
 * @param options - Harness home selection.
 * @returns the matching credential revision, or undefined.
 */
export async function verifyAuthenticationToken(
  value: string,
  options: AuthenticationManagementOptions = {},
): Promise<AuthenticationCredential | undefined> {
  const parsed = parseToken(value)
  if (parsed === undefined) return undefined
  const registry = await readAuthenticationTokenRegistry(options)
  const record = registry.tokens.find(token => token.id === parsed.id)
  if (record === undefined) return undefined
  const expected = Buffer.from(record.digest, 'hex')
  const actual = Buffer.from(secretDigest(parsed.secret), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
  return { tokenId: record.id, tokenName: record.name, generation: record.generation }
}
