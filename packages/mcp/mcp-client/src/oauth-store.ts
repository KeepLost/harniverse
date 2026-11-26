/**
 * The OAuth grant record of one server: the versioned JSON document stored
 * through the credentials seam, the binding that keeps a grant with the
 * endpoint and OAuth options it was issued for, and the structural face of
 * that seam this package reads and writes it through.
 *
 * @module
 */

import { z } from 'zod'
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Config } from './config.ts'
import { McpAuthorizationRequired, McpLocalError } from './oauth-errors.ts'

/** Prefix of every OAuth grant reference in the credentials seam. */
const REF_PREFIX = 'mcp_oauth_'

/**
 * The credential reference of one server's OAuth grant. The server key is
 * hex-encoded, so the reference is unique per key and safe as a YAML key and
 * as a filesystem name.
 * @param serverKey - Stable identity of the server: a shared owner's settings id, a standalone row's serverName.
 * @returns The reference the grant is stored under.
 */
export function mcpOAuthCredentialRef(serverKey: string): string {
  return `${REF_PREFIX}${Buffer.from(serverKey, 'utf8').toString('hex')}`
}

/** In-flight write per grant reference, shared by every session and flow of one server in this process. */
const grantWriteChains = new Map<string, Promise<unknown>>()

/**
 * Run one write behind every earlier write of the same grant reference. A
 * refresh re-reads the grant inside the chain before it decides whether a
 * token request is still needed, so concurrent callers share one token
 * request, two refreshes of one refresh token never overlap, and a commit or
 * a sign-out never interleaves with a refresh of the record it replaces.
 * @param ref - Credential reference of the grant.
 * @param write - The serialized write; it reads the current record itself instead of trusting an earlier read.
 * @returns The write's own result.
 */
export function serializedGrantWrite<T>(ref: string, write: () => Promise<T>): Promise<T> {
  const chain = (grantWriteChains.get(ref) ?? Promise.resolve()).then(write, write)
  grantWriteChains.set(ref, chain)
  const forget = (): void => {
    if (grantWriteChains.get(ref) === chain) grantWriteChains.delete(ref)
  }
  void chain.then(forget, forget)
  return chain
}

/**
 * The stable identity a config entry's OAuth grant is stored under: a shared
 * owner's settings id, or a standalone row's public server name.
 * @param config - Resolved config entry.
 * @returns The identity the credential reference is derived from.
 */
export function mcpOAuthServerKey(config: Config): string {
  return 'serverId' in config && typeof config.serverId === 'string' ? config.serverId : config.serverName
}

/** Read and write face of the credentials seam (structural: this package does not depend on the credentials package). */
export interface McpOAuthCredentialStore {
  /**
   * Read one reference's current value.
   * @param ref - Reference to resolve.
   * @returns The stored value, or `undefined` while nothing is stored.
   */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
  /**
   * Durably store one value under a reference.
   * @param ref - Reference to store under.
   * @param value - Non-empty value.
   */
  set(ref: string, value: string): Promise<void>
  /**
   * Remove one reference; removing an absent reference is a no-op.
   * @param ref - Reference to remove.
   */
  unset(ref: string): Promise<void>
}

const GrantSchema = z.object({
  version: z.literal(1),
  serverUrl: z.string(),
  issuer: z.string(),
  metadata: z.union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema]).optional(),
  clientInformation: OAuthClientInformationSchema,
  registered: z.boolean(),
  redirectUri: z.string().optional(),
  resource: z.string().optional(),
  scope: z.string().optional(),
  tokens: OAuthTokensSchema,
  expiresAt: z.number().optional(),
  configured: z.object({ clientId: z.string().optional(), scope: z.string().optional() }),
})

/** Versioned, self-contained grant of one server: what the durable record holds. */
export type McpOAuthGrant = z.infer<typeof GrantSchema>

/** The endpoint and OAuth options a grant must have been issued for. */
export interface McpOAuthBinding {
  /** Canonical MCP endpoint URL the tokens may be presented to. */
  serverUrl: string
  /** Configured public client id, when the entry names one. */
  clientId?: string
  /** Configured scope, when the entry names one. */
  scope?: string
}

/** Whether a grant was issued for exactly this endpoint and these OAuth options. */
function isBound(grant: McpOAuthGrant, binding: McpOAuthBinding): boolean {
  return grant.serverUrl === binding.serverUrl
    && grant.configured.clientId === binding.clientId
    && grant.configured.scope === binding.scope
}

/** Storage of one server's grant under its credential reference. */
export class McpOAuthGrantStore {
  /** Credential reference the grant is stored under. */
  readonly ref: string

  /**
   * @param store - Credentials seam face, or `undefined` where no provider serves the composition.
   * @param serverKey - Stable identity the reference is derived from.
   */
  constructor(
    private readonly store: McpOAuthCredentialStore | undefined,
    serverKey: string,
  ) {
    this.ref = mcpOAuthCredentialRef(serverKey)
  }

  /**
   * Read the stored grant and judge its binding.
   * @param binding - Endpoint and options the grant must match.
   * @returns The bound grant.
   * @throws {McpAuthorizationRequired} with reason `missing` when nothing is stored, or
   *   `binding` when the record is unreadable, of another version, or bound elsewhere.
   */
  async read(binding: McpOAuthBinding): Promise<McpOAuthGrant> {
    const hit = await this.store?.resolve(this.ref)
    if (hit === undefined) throw new McpAuthorizationRequired('missing')
    const grant = parseGrant(hit.value)
    if (grant === undefined || !isBound(grant, binding)) throw new McpAuthorizationRequired('binding')
    return grant
  }

  /**
   * Replace the stored grant. A caller that reads the record before writing
   * wraps the pair in {@link serializedGrantWrite}; a refresh already runs there.
   * @param grant - Complete grant record.
   */
  async write(grant: McpOAuthGrant): Promise<void> {
    await this.requireStore().set(this.ref, JSON.stringify(grant))
  }

  /**
   * Remove the stored grant; an absent grant is not an error.
   */
  async clear(): Promise<void> {
    await this.store?.unset(this.ref)
  }

  /**
   * The provider that serves this composition.
   * @returns The credentials seam face.
   * @throws when no credentials provider is composed.
   */
  requireStore(): McpOAuthCredentialStore {
    if (this.store === undefined) throw new McpLocalError('MCP OAuth requires a credentials provider', 'MCP_OAUTH_FAILED')
    return this.store
  }
}

function parseGrant(value: string): McpOAuthGrant | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    const result = GrantSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    // A hand-edited record may be any text; it reads as an incompatible record instead of failing the connection.
    return undefined
  }
}
