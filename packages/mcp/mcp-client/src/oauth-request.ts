/**
 * The fetch every OAuth protocol step runs through: one abort signal and one
 * deadline per request, the HTTPS-or-loopback transport rule, no redirect
 * following, and a safe failure that never quotes an upstream response body.
 *
 * @module
 */

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { McpLocalError } from './oauth-errors.ts'
import { assertOAuthUrl } from './oauth-options.ts'

/** Bounds of one OAuth request. */
export interface OAuthRequestOptions {
  /** Lifetime of the operation the request belongs to; an abort cancels the request. */
  readonly signal: AbortSignal
  /** Deadline of this single request in milliseconds. */
  readonly timeoutMs: number
  /** Network implementation; defaults to the global fetch. */
  readonly fetch?: typeof fetch
}

/** A signal no passive request is ever cancelled through. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal

function cancelled(cause: unknown): McpLocalError {
  return new McpLocalError('MCP OAuth request was cancelled', 'MCP_OAUTH_FAILED', { cause })
}

/**
 * Create the fetch of one OAuth operation. Every request is sent to an HTTPS
 * or loopback URL only, with a per-request deadline, and refuses to follow a
 * redirect: a redirected token or registration request would carry its body
 * to a destination the metadata never named.
 * @param options - Operation lifetime, per-request deadline, and network implementation.
 * @returns The fetch the SDK protocol functions receive.
 * @throws {McpLocalError} with code `MCP_OAUTH_FAILED` when the URL is refused, the operation
 *   is cancelled, the deadline passes, or the network fails.
 */
export function oauthFetch(options: OAuthRequestOptions): FetchLike {
  return async (input, init) => {
    if (options.signal.aborted) throw cancelled(options.signal.reason)
    let url: URL
    try {
      url = assertOAuthUrl(input)
    } catch (error) {
      throw new McpLocalError('MCP OAuth requires HTTPS except for loopback HTTP', 'MCP_OAUTH_FAILED', { cause: error })
    }
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signals = [options.signal, timeout, ...init?.signal ? [init.signal] : []]
    // Read through a call: an earlier check must not narrow the flag across the await below.
    const withdrawn = (): boolean => options.signal.aborted
    try {
      return await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
    } catch (error) {
      if (withdrawn()) throw cancelled(error)
      if (timeout.aborted) {
        throw new McpLocalError(`MCP OAuth request timed out after ${String(options.timeoutMs)}ms`, 'MCP_OAUTH_FAILED', { cause: error })
      }
      throw new McpLocalError('MCP OAuth request failed', 'MCP_OAUTH_FAILED', { cause: error })
    }
  }
}

/**
 * Replace an upstream failure with a safe local error: a fixed message that
 * names the OAuth error code at most, with the upstream error attached as
 * its cause for same-process diagnostics. The cause text may quote a response
 * body and is never logged.
 * @param error - Failure of an SDK protocol function.
 * @param operation - Name of the failed step, for the message.
 * @returns The error a caller receives.
 */
export function oauthFailure(error: unknown, operation: string): McpLocalError {
  if (error instanceof McpLocalError) return error
  if (error instanceof OAuthError) {
    const message = `MCP OAuth ${operation} was refused by the authorization server (${error.errorCode})`
    return new McpLocalError(message, 'MCP_OAUTH_FAILED', { cause: error })
  }
  return new McpLocalError(`MCP OAuth ${operation} failed`, 'MCP_OAUTH_FAILED', { cause: error })
}
