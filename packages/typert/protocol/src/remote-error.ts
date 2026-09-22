/**
 * The one Remote failure class shared by owners, the Gateway, and consumers.
 * @module @deepseek-ai/dsh-typert-protocol
 */

import type { RemoteFailure } from './types.ts'

/**
 * One Remote call failure: a real Error carrying its stable code and typed
 * details. Owners throw it at the failure point; the Host Gateway preserves
 * its code, message, and details onto the wire; consumers discriminate by
 * `code`, never by instanceof, because the wire rebuilds structural
 * failures. The class is structurally assignable to {@link RemoteFailure}
 * (open `code` string), so Remote error branches accept both spellings.
 */
export class RemoteError<Code extends string = string> extends Error {
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError: true = true

  /**
   * @param code - stable failure code declared by the carrier's error vocabulary.
   * @param message - human diagnostic carried across the wire.
   * @param details - structured payload discriminated by the code.
   * @param options - standard Error options (`cause` survives in-process only).
   */
  constructor(
    readonly code: Code,
    message: string,
    readonly details: object,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/**
 * Structurally identify a RemoteError thrown across module or realm copies of
 * this class. Mechanism-internal: the Gateway and test assertions use it;
 * business code receives typed failures and never needs it.
 * @param value - a caught value.
 * @returns the failure when the marker matches, otherwise undefined.
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  // Structural, not instanceof: an Error thrown in another realm (iframe, VM)
  // fails instanceof Error here, so the marker plus the code field is the test.
  if (typeof value === 'object' && value !== null
    && (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (value as { code?: unknown }).code === 'string') {
    return value as unknown as RemoteFailure
  }
  return undefined
}
