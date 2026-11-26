/**
 * Shared doubles and helpers of the OAuth specs: an in-memory credentials
 * seam, the Streamable HTTP config of a fixture, and the browser round trip a
 * spec drives by hand (open the authorization page, follow its redirect).
 */
import { oauthConfigOf } from '@deepseek-ai/dsh-mcp-client/src/oauth-options.ts'
import type { OAuthConfig } from '@deepseek-ai/dsh-mcp-client/src/oauth-options.ts'
import type { McpConnectionOAuth } from '@deepseek-ai/dsh-mcp-client/src/oauth-session.ts'
import { mcpOAuthCredentialRef } from '@deepseek-ai/dsh-mcp-client/src/oauth-store.ts'
import type { McpOAuthCredentialStore, McpOAuthGrant } from '@deepseek-ai/dsh-mcp-client/src/oauth-store.ts'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client/src/config.ts'
import type { OAuthFixture } from './oauth-fixture-server.ts'

/** Redirect URI the specs register and advertise. */
export const REDIRECT_URI = 'http://127.0.0.1:43000/mcp/oauth/callback/fixture'

/** State the specs bind an authorization request to. */
export const STATE = 'state-of-the-spec-attempt'

/** In-memory credentials seam double. */
export class MemoryCredentials implements McpOAuthCredentialStore {
  readonly values = new Map<string, string>()

  resolve = async (ref: string): Promise<{ readonly value: string } | undefined> => {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value }
  }

  set = async (ref: string, value: string): Promise<void> => {
    this.values.set(ref, value)
  }

  unset = async (ref: string): Promise<void> => {
    this.values.delete(ref)
  }
}

/** Resolve the OAuth options of a config entry, or fail the spec when the entry has none. */
export function optionsOf(config: StreamableHttpConfig): OAuthConfig {
  const enabled = oauthConfigOf(config, 'spec')
  if (enabled === undefined) throw new Error('the spec config carries no oauth field')
  return enabled.options
}

/** An OAuth-configured Streamable HTTP config against the fixture. */
export function httpConfig(fixture: OAuthFixture, overrides: Partial<StreamableHttpConfig> = {}): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'web',
    url: fixture.url,
    headers: {},
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 3 },
    oauth: true,
    ...overrides,
  }
}

/** Open the authorization page the way a browser would and resolve the callback the authorization server redirects the browser to. */
export async function redirectOf(authorizationUrl: string): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (location === null) throw new Error('the authorization page did not redirect')
  return new URL(location)
}

/** The query the authorization server attached to its redirect. */
export async function consent(authorizationUrl: string): Promise<URLSearchParams> {
  return (await redirectOf(authorizationUrl)).searchParams
}

/** Run one complete explicit authorization: discovery, registration, consent, exchange, commit. */
export async function authorize(oauth: McpConnectionOAuth, redirectUri: string = REDIRECT_URI): Promise<URLSearchParams> {
  const flow = oauth.createFlow()
  const { authorizationUrl } = await flow.begin({ redirectUri, state: STATE })
  const callback = await consent(authorizationUrl)
  const code = callback.get('code')
  if (code === null) throw new Error(`the authorization server answered ${callback.get('error') ?? 'without a code'}`)
  await flow.exchange({ code, iss: callback.get('iss') ?? undefined })
  await flow.commit()
  return callback
}

/** The grant stored for one server key. */
export function readGrant(store: MemoryCredentials, serverKey = 'web'): McpOAuthGrant | undefined {
  const value = store.values.get(mcpOAuthCredentialRef(serverKey))
  return value === undefined ? undefined : JSON.parse(value) as McpOAuthGrant
}

/** Replace the grant stored for one server key. */
export function writeGrant(store: MemoryCredentials, grant: McpOAuthGrant, serverKey = 'web'): void {
  store.values.set(mcpOAuthCredentialRef(serverKey), JSON.stringify(grant))
}

/** Move a stored grant's access token past its refresh deadline. */
export function expireGrant(store: MemoryCredentials, serverKey = 'web'): void {
  const grant = readGrant(store, serverKey)
  if (grant === undefined) throw new Error('no grant is stored')
  writeGrant(store, { ...grant, expiresAt: Date.now() - 1_000 }, serverKey)
}
