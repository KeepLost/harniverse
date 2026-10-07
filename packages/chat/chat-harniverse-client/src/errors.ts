/**
 * Classified failures of the Harniverse chat client.
 * @module @deepseek-ai/dsh-chat-harniverse-client/errors
 */

/** Closed classification of client failures. */
export type HarniverseErrorCode =
  | 'endpoint-denied'
  | 'remote-host-invalid'
  | 'credential-missing'
  | 'authentication-failed'
  | 'transport-failed'
  | 'rpc-rejected'
  | 'protocol-violation'

/** Facts attached to a {@link HarniverseError}. */
export interface HarniverseErrorDetails {
  /** Business error code from a rejected RPC (`session-not-found`, `idempotency-key-reused`, ...). */
  rpcCode?: string
  /** HTTP status of a failed carrier response. */
  status?: number
  cause?: unknown
}

/** The single error class every client method throws. */
export class HarniverseError extends Error {
  /** Classification the bridge routes on. */
  readonly code: HarniverseErrorCode
  /** Business error code when `code` is `rpc-rejected`. */
  readonly rpcCode?: string
  /** HTTP status when the carrier itself failed. */
  readonly status?: number

  constructor(code: HarniverseErrorCode, message: string, details: HarniverseErrorDetails = {}) {
    super(`chat-harniverse-client: ${message}`, details.cause === undefined ? undefined : { cause: details.cause })
    this.code = code
    if (details.rpcCode !== undefined) this.rpcCode = details.rpcCode
    if (details.status !== undefined) this.status = details.status
  }
}

/**
 * Render any thrown value for a diagnostic message.
 * @param error - a caught value.
 * @returns the message of an Error, or the stringified value.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
