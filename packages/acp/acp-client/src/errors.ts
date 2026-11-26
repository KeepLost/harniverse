/**
 * Error taxonomy of the ACP client core. Every failure a consumer observes is
 * an `AcpError`; its kind names where the failure originated.
 * @module @deepseek-ai/dsh-acp-client/errors
 */

/** Where a failure originated. */
export type AcpErrorKind =
  /** The agent process could not be started. */
  | 'spawn'
  /** `initialize` failed, or the agent answered an unsupported protocol version. */
  | 'handshake'
  /** The agent requires an authentication this client cannot complete. */
  | 'auth'
  /** The agent did not advertise the requested operation. */
  | 'unsupported'
  /** The agent answered a request with a protocol error. */
  | 'protocol'
  /** The connection closed before an answer arrived. */
  | 'transport'

/** Construction details of an {@link AcpError}. */
export interface AcpErrorOptions {
  /** JSON-RPC error code the agent answered with. */
  readonly code?: number
  /** The thrown value this error summarizes. */
  readonly cause?: unknown
}

/** The failure class of the ACP client core. */
export class AcpError extends Error {
  /** Where the failure originated. */
  readonly kind: AcpErrorKind
  /** JSON-RPC error code the agent answered with, when it answered with one. */
  readonly code: number | undefined

  constructor(kind: AcpErrorKind, message: string, options: AcpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AcpError'
    this.kind = kind
    this.code = options.code
  }
}

/**
 * Whether a thrown value is the ACP client's own failure class.
 * @param error - a thrown value.
 * @returns whether it is an `AcpError`.
 */
export function isAcpError(error: unknown): error is AcpError {
  return error instanceof AcpError
}

/** JSON-RPC `Authentication required`, the code an agent answers when its method was never completed. */
export const AUTH_REQUIRED_CODE = -32000

/**
 * The kind an agent-side JSON-RPC error code names; `fallback` for every other code.
 * @param code - the JSON-RPC error code the agent answered with.
 * @param fallback - the kind for a code that names no more specific one.
 * @returns the error kind.
 */
export function acpErrorKindForCode(code: number | undefined, fallback: AcpErrorKind): AcpErrorKind {
  if (code === AUTH_REQUIRED_CODE) return 'auth'
  if (code === -32022) return 'handshake'
  if (code === -32601) return 'unsupported'
  return fallback
}

/**
 * Express a thrown value as an {@link AcpError}. An `AcpError` passes through
 * unchanged; an SDK `RequestError` keeps its JSON-RPC code.
 * @param kind - the kind for a value that carries no more specific one.
 * @param error - the thrown value.
 * @returns the error every consumer observes.
 */
export function toAcpError(kind: AcpErrorKind, error: unknown): AcpError {
  if (error instanceof AcpError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
    ? error.code
    : undefined
  const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error)
  return new AcpError(acpErrorKindForCode(code, kind), message, {
    ...code === undefined ? {} : { code },
    cause: error,
  })
}
