/** Public-key Access Token exchange for remote SDK and automation clients. */

export interface GrantAccessOptions {
  /** HTTPS Harness origin, or loopback HTTP for local development. */
  origin: string
  /** Grant id printed by `dsh auth client add`. */
  grantId: string
  /** Sign one UTF-8 challenge payload as base64url IEEE-P1363 ECDSA/SHA-256. */
  signChallenge(payload: string): Promise<string>
  /** Fetch implementation used for the challenge and exchange. */
  fetch?: typeof globalThis.fetch
  /** Refresh this long before expiry. Defaults to 30 seconds. */
  renewBeforeMs?: number
}

interface AccessToken {
  value: string
  expiresAt: number
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

function origin(value: string): string {
  const parsed = new URL(value)
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/') {
    throw new TypeError('GrantAccess: origin must not contain credentials, path, query, or fragment')
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new TypeError('GrantAccess: remote origins require HTTPS')
  }
  return parsed.origin
}

/**
 * Obtain and renew short Access Tokens while the caller retains the private key.
 * The class never receives an exportable long-lived secret.
 */
export class GrantAccess {
  private readonly origin: string
  private readonly grantId: string
  private readonly signChallenge: (payload: string) => Promise<string>
  private readonly request: typeof globalThis.fetch
  private readonly renewBeforeMs: number
  private token: AccessToken | undefined
  private renewing: { epoch: number; promise: Promise<AccessToken> } | undefined
  private epoch = 0

  constructor(options: GrantAccessOptions) {
    this.origin = origin(options.origin)
    if (options.grantId.length === 0) throw new TypeError('GrantAccess: grantId must not be empty')
    if (options.renewBeforeMs !== undefined && (!Number.isSafeInteger(options.renewBeforeMs) || options.renewBeforeMs < 0)) {
      throw new RangeError('GrantAccess: renewBeforeMs must be a non-negative integer')
    }
    this.grantId = options.grantId
    this.signChallenge = payload => options.signChallenge(payload)
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.renewBeforeMs = options.renewBeforeMs ?? 30_000
  }

  /** Forget the current process-memory Access Token. */
  clear(): void {
    this.epoch += 1
    this.token = undefined
    this.renewing = undefined
  }

  /**
   * Return a current Bearer header, exchanging a signed challenge when needed.
   * @returns a complete Authorization header value.
   */
  async authorization(): Promise<string> {
    const token = await this.accessToken()
    return `Bearer ${token.value}`
  }

  /**
   * Perform one fetch with a current short-lived Bearer credential.
   * @param input - fetch target.
   * @param init - request options merged with the Authorization header.
   * @returns the authenticated response.
   */
  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    let source: Request | undefined
    let target: URL
    if (input instanceof Request) {
      source = input
      target = new URL(input.url)
    } else {
      target = new URL(typeof input === 'string' ? input : input.href, this.origin)
    }
    if (target.origin !== this.origin) {
      throw new TypeError('GrantAccess: authenticated requests must use the same Harness origin')
    }
    const headers = new Headers(source?.headers)
    if (init.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
    }
    headers.set('authorization', await this.authorization())
    return this.request(source ?? target, { ...init, headers })
  }

  private async accessToken(): Promise<AccessToken> {
    if (this.token !== undefined && this.token.expiresAt - this.renewBeforeMs > Date.now()) return this.token
    const epoch = this.epoch
    const renewal = this.renewing?.epoch === epoch
      ? this.renewing
      : { epoch, promise: this.exchange() }
    this.renewing = renewal
    try {
      const token = await renewal.promise
      if (this.epoch === epoch) this.token = token
      return token
    } finally {
      if (this.renewing === renewal) this.renewing = undefined
    }
  }

  private async exchange(): Promise<AccessToken> {
    const challengeResponse = await this.request(`${this.origin}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantId: this.grantId, purpose: 'access-token' }),
    })
    if (!challengeResponse.ok) throw new Error(`GrantAccess: challenge rejected (${String(challengeResponse.status)})`)
    const challenge: unknown = await challengeResponse.json()
    if (!exactObject(challenge, ['id', 'payload', 'expiresAt'])
      || typeof challenge.id !== 'string' || typeof challenge.payload !== 'string' || typeof challenge.expiresAt !== 'string') {
      throw new Error('GrantAccess: invalid challenge response')
    }
    const signature = await this.signChallenge(challenge.payload)
    const tokenResponse = await this.request(`${this.origin}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: challenge.id, signature }),
    })
    if (!tokenResponse.ok) throw new Error(`GrantAccess: token exchange rejected (${String(tokenResponse.status)})`)
    const token: unknown = await tokenResponse.json()
    if (!exactObject(token, ['accessToken', 'expiresAt'])
      || typeof token.accessToken !== 'string' || typeof token.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(token.expiresAt))) {
      throw new Error('GrantAccess: invalid token response')
    }
    return { value: token.accessToken, expiresAt: Date.parse(token.expiresAt) }
  }
}
