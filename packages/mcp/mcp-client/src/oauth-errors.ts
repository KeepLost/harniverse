/**
 * Coded errors the MCP client bridge owns. A tool call, a resource request,
 * or an authorization attempt that cannot proceed fails with one of these,
 * so a caller can branch on the code without parsing message text.
 *
 * @module
 */

/** Stable codes of the bridge's own errors. */
export type McpLocalErrorCode =
  /** The server needs a user authorization before the bridge can authenticate. */
  | 'MCP_AUTHORIZATION_REQUIRED'
  /** An OAuth operation failed without a user-action reason. */
  | 'MCP_OAUTH_FAILED'

/** Why a connection waits for an explicit authorization. */
export type McpAuthorizationReason =
  /** No grant is stored for this server. */
  | 'missing'
  /** The stored grant expired and cannot be refreshed. */
  | 'expired'
  /** The stored grant belongs to another endpoint, authorization server, or OAuth configuration. */
  | 'binding'
  /** The authorization server or the MCP server refused the client or the token. */
  | 'rejected'
  /** The MCP server requires a scope the grant does not carry. */
  | 'scope'

/** An error of the MCP client bridge, identified by a stable code. */
export class McpLocalError extends Error {
  /**
   * @param message - Safe description; it never carries a token, code, or verifier.
   * @param code - Stable code a caller branches on.
   * @param options - `cause` carries the upstream failure for same-process diagnostics;
   *   its text may quote a response body and is never logged.
   */
  constructor(message: string, readonly code: McpLocalErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpLocalError'
  }
}

/** The server cannot be reached until the user authorizes or re-authorizes it. */
export class McpAuthorizationRequired extends McpLocalError {
  /**
   * @param reason - Why the bridge cannot authenticate.
   * @param options - `cause` carries the upstream failure, when there is one.
   */
  constructor(readonly reason: McpAuthorizationReason, options?: ErrorOptions) {
    super(`MCP OAuth requires authorization: ${reason}`, 'MCP_AUTHORIZATION_REQUIRED', options)
    this.name = 'McpAuthorizationRequired'
  }
}
