/**
 * OAuth options of a Streamable HTTP server entry: the config field, its
 * schema, and the one resolve step from the raw field to the budgeted options
 * the connection and the explicit authorization flow run with.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Config, StreamableHttpConfig } from './config.ts'

/** OAuth options after every default is applied. */
export interface OAuthConfig {
  /** Pre-registered public client id; omission lets explicit authorization register a client dynamically. */
  clientId?: string
  /** Requested scope; omission uses the authorization server's challenge. */
  scope?: string
  /** Deadline of one authorization-server request in milliseconds (default 10000). */
  requestTimeoutMs: number
  /** Deadline of one explicit authorization from its start through the token exchange in milliseconds (default 600000). */
  authorizationTimeoutMs: number
}

/** Raw `oauth` config field: `true` selects every default. */
export type OAuthInput =
  | true
  | {
    /** Pre-registered public client id; omission lets explicit authorization register a client dynamically. */
    clientId?: string
    /** Requested scope; omission uses the authorization server's challenge. */
    scope?: string
    /** Deadline of one authorization-server request in milliseconds (default 10000). */
    requestTimeoutMs?: number
    /** Deadline of one explicit authorization from its start through the token exchange in milliseconds (default 600000). */
    authorizationTimeoutMs?: number
  }

/** The field as Schemastery hands it over: an empty `oauth:` in YAML resolves to `null`. */
export type OAuthFieldInput = OAuthInput | null | undefined

/** Defaults shared by the schema and {@link resolveOAuthConfig}. */
export const OAUTH_DEFAULTS: Readonly<Pick<OAuthConfig, 'requestTimeoutMs' | 'authorizationTimeoutMs'>> = Object.freeze({
  requestTimeoutMs: 10_000,
  authorizationTimeoutMs: 600_000,
})

const BUDGET_KEYS = ['requestTimeoutMs', 'authorizationTimeoutMs'] as const
const IDENTITY_KEYS = ['clientId', 'scope'] as const
const OPTION_KEYS = new Set<string>([...IDENTITY_KEYS, ...BUDGET_KEYS])

/** Refusal shared by every URL the OAuth flow requests or advertises. */
const TRANSPORT_REFUSAL = 'MCP OAuth requires HTTPS except for loopback HTTP'

const OAuthOptions = z.object({
  clientId: z.string(),
  scope: z.string(),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(OAUTH_DEFAULTS.requestTimeoutMs),
  authorizationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(OAUTH_DEFAULTS.authorizationTimeoutMs),
})

/** Schema of the `oauth` config field. */
export const OAuthField = z.union([z.const(true), OAuthOptions])

function parseUrl(value: string | URL): URL | undefined {
  try {
    return new URL(value)
  } catch {
    // The unparsable text is not echoed anywhere: an endpoint or redirect value may carry a secret.
    return undefined
  }
}

/**
 * Judge one URL by the transport rule of every OAuth request and redirect:
 * HTTPS, or HTTP on a loopback host.
 * @param value - Absolute URL that is about to be requested or advertised.
 * @returns The parsed URL.
 * @throws when the URL is unparsable or is plain HTTP to a non-loopback host.
 */
export function assertOAuthUrl(value: string | URL): URL {
  const url = parseUrl(value)
  if (url === undefined) throw new Error(TRANSPORT_REFUSAL)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(TRANSPORT_REFUSAL)
  }
  return url
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Resolve the raw `oauth` field of one Streamable HTTP entry. Programmatic
 * construction may bypass Schemastery normalization, so every default and
 * bound is re-judged here.
 * @param oauth - Raw `oauth` field; omission disables OAuth.
 * @param server - Endpoint and headers of the same entry.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved options, or `undefined` when the entry has no `oauth` field.
 * @throws for a value that is neither `true` nor an options object, an unknown option, a blank identity,
 *   an out-of-range budget, an endpoint that is not HTTPS or loopback HTTP, or an `Authorization` header.
 */
export function resolveOAuthConfig(oauth: OAuthFieldInput, server: Pick<StreamableHttpConfig, 'url' | 'headers'>, path: string): OAuthConfig | undefined {
  if (oauth === undefined) return undefined
  if (oauth !== true && (typeof oauth !== 'object' || oauth === null)) {
    throw new TypeError(`${path}: oauth must be true or an options object`)
  }
  assertOAuthUrl(server.url)
  if (Object.keys(server.headers).some(name => name.toLowerCase() === 'authorization')) {
    throw new TypeError(`${path}: oauth cannot be combined with an Authorization header: OAuth owns the Authorization header`)
  }
  if (oauth === true) return Object.freeze({ ...OAUTH_DEFAULTS })
  for (const key of Object.keys(oauth)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`${path}: oauth.${key} is not an oauth option`)
  }
  for (const key of IDENTITY_KEYS) {
    const value: string | undefined = oauth[key]
    if (value !== undefined && value.trim() === '') throw new TypeError(`${path}: oauth.${key} must not be blank`)
  }
  const budgets = {} as Pick<OAuthConfig, 'requestTimeoutMs' | 'authorizationTimeoutMs'>
  for (const key of BUDGET_KEYS) {
    const budget = oauth[key] ?? OAUTH_DEFAULTS[key]
    if (!Number.isInteger(budget) || budget < 1 || budget > MAX_TIMER_DELAY_MS) {
      throw new TypeError(`${path}: oauth.${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    budgets[key] = budget
  }
  return Object.freeze({
    ...oauth.clientId === undefined ? {} : { clientId: oauth.clientId },
    ...oauth.scope === undefined ? {} : { scope: oauth.scope },
    ...budgets,
  })
}

/** A Streamable HTTP entry whose `oauth` field is set, resolved with its OAuth options. */
export interface OAuthEnabledConfig {
  readonly config: StreamableHttpConfig
  readonly options: OAuthConfig
}

/**
 * Resolve the OAuth options of a whole config entry, judged against its own
 * transport, endpoint, and headers.
 * @param config - Resolved config entry.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The entry with its resolved options, or `undefined` for stdio or an entry without `oauth`.
 * @throws when a stdio entry carries `oauth`, or for every {@link resolveOAuthConfig} refusal.
 */
export function oauthConfigOf(config: Config, path: string): OAuthEnabledConfig | undefined {
  if (config.transport === 'stdio') {
    if ('oauth' in config && config.oauth !== undefined) throw new TypeError(`${path}: oauth is only valid for streamable-http`)
    return undefined
  }
  const options = resolveOAuthConfig(config.oauth, config, path)
  return options === undefined ? undefined : { config, options }
}
