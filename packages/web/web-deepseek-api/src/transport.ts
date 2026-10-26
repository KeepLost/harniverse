/**
 * Authentication and redirect-rejecting transport shared by the Search and
 * Fetch API providers in this package. Credential resolution and the dispatch
 * call deliberately repeat the retired `dsh-web-search-deepseek` provider's
 * shapes (absorbed wave-4 W06, retired by this package), so no runtime
 * dependency carries over; the `jscpd:ignore` regions mark those repeats.
 * @module @deepseek-ai/dsh-web-deepseek-api/transport
 */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

const USER_AGENT = 'deepseek-harness/0.0.1'

/** Authentication values resolved once for an operation. */
export interface DeepSeekWebAuth {
  /** Literal API key; takes precedence over the credential resolver. */
  apiKey?: string
  /** Resolve the current API key without retaining it. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-key diagnostics. */
  apiKeyEnv?: CredentialRef
}

/** User-owned endpoint settings named by dispatch failures. */
export interface DeepSeekWebGuidance {
  /** Capability whose endpoint failed. */
  subject: 'Search' | 'Fetch'
  /** Plugin configuration namespace. */
  plugin: string
  /** Endpoint configuration field. */
  field: string
  /** Local settings label. */
  label: string
  /** Built-in settings page title. */
  page: string
}

/** One fully resolved web API request. */
interface DeepSeekWebRequest<T> {
  /** Absolute dispatch URL. */
  endpoint: string
  /** JSON request body. */
  body: object
  /** Validate and project the response. */
  decode: (payload: unknown) => T
  /** Endpoint recovery settings. */
  guidance: DeepSeekWebGuidance
}

/**
 * Check whether an authentication source exists; does not resolve credentials.
 * @param auth - Sources for the operation.
 * @returns Whether a literal key or resolver is present.
 */
export function hasDeepSeekWebCredential(auth: DeepSeekWebAuth): boolean {
  return (auth.apiKey?.length ?? 0) > 0 || auth.resolveApiKey !== undefined
}

/**
 * Narrow a remote JSON object.
 * @param value - Untrusted JSON.
 * @returns Whether readable object fields exist.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Report malformed upstream JSON without embedding response content.
 * @returns The stable provider error.
 */
export function invalidResponse(): WebError {
  return new WebError('DeepSeek returned an invalid response body', 'WEB_PROVIDER_ERROR')
}

/**
 * Dispatch one operation using a single settings and credential snapshot.
 * @param options - Authentication sources for this operation.
 * @param request - Resolved endpoint, JSON payload, and response decoder.
 * @param signal - Caller cancellation signal.
 * @returns The validated provider result.
 */
export async function dispatchDeepSeekWeb<T>(
  options: DeepSeekWebAuth,
  request: DeepSeekWebRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { endpoint, body, decode, guidance } = request
  const apiKey = await resolveApiKey(options, request.guidance.plugin, signal)
  throwIfWebAborted(signal)
  let response: Response
  /* jscpd:ignore-start */
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw webAborted(signal, error)
    throw webEndpointError(
      guidance,
      endpoint,
      `DeepSeek web request failed: ${String(error)}`,
      error,
    )
  }
  /* jscpd:ignore-end */

  if (!response.ok) {
    const status = response.status
    let message = `DeepSeek API error (HTTP ${status})`
    try {
      const parsed: unknown = await response.json()
      if (isRecord(parsed)) {
        const detail = typeof parsed.error === 'string'
          ? parsed.error
          : isRecord(parsed.error) ? parsed.error.message : parsed.message
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
      }
    } catch (error: unknown) {
      // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
      // into a generic HTTP-error message — cancellation is not a provider
      // error (the seam's cancellation contract).
      if (signal?.aborted === true || isAbortError(error)) throw webAborted(signal, error)
      // Otherwise: the HTTP status is already captured in `message` above; a
      // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
      // cost a richer provider message, never the real error.
    }
    throw webEndpointError(guidance, endpoint, message)
  }

  try {
    const payload: unknown = await response.json()
    throwIfWebAborted(signal)
    return decode(payload)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw webAborted(signal, error)
    const message = error instanceof WebError
      ? error.message
      : `DeepSeek returned an unprocessable response body: ${String(error)}`
    throw webEndpointError(guidance, endpoint, message, error)
  }
}

/**
 * Add endpoint recovery instructions to failures that occur after request dispatch begins.
 * @param options - the plugin, settings field, and settings page the guidance names.
 * @param endpoint - the dispatched endpoint.
 * @param message - the failure description.
 * @param cause - the underlying failure, when one exists.
 * @returns the provider failure with recovery instructions.
 */
function webEndpointError(
  options: DeepSeekWebGuidance,
  endpoint: string,
  message: string,
  cause?: unknown,
): WebError {
  return new WebError(
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. `
      + `${options.subject} endpoint configuration is separate from chat. If that endpoint is not intended, `
      + `guide the user to Plugins > Built-in plugin settings > ${options.page}, where they can `
      + `change and save ${options.label}. If that settings page is unavailable, the user can set `
      + `${options.plugin}.${options.field} to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/* jscpd:ignore-start */
/**
 * Resolve one operation's API key without retaining it on the provider.
 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
 * @param plugin - configuration namespace named by the missing-key diagnostic.
 * @param signal - abort signal for the surrounding operation.
 * @returns the resolved key.
 */
async function resolveApiKey(options: DeepSeekWebAuth, plugin: string, signal?: AbortSignal): Promise<string> {
  throwIfWebAborted(signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  const { resolveApiKey } = options
  const resolved = resolveApiKey === undefined ? undefined : await resolveCredential(resolveApiKey, signal)
  if (resolved !== undefined && resolved.length > 0) return resolved
  const ref = options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  throw new WebError(
    `DeepSeek web access has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ` "apiKey" in the ${plugin} config`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Run one credential resolver under the operation's cancellation signal. An
 * already-cancelled operation never starts the resolver.
 * @param resolve - the resolver; a synchronous throw is mapped like a rejection.
 * @param signal - abort signal for the surrounding operation.
 * @returns the resolved credential, or undefined when the resolver supplied none.
 * @throws {@link WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_ERROR` when the resolver fails.
 */
async function resolveCredential(
  resolve: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfWebAborted(signal)
  try {
    return await abortable(resolve(), signal)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw webAborted(signal, error)
    throw new WebError(
      `DeepSeek web credential resolution failed: ${String(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(webAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(webAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfWebAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw webAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function webAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DeepSeek web request aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
