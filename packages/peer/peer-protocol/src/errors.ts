/** Closed peer error vocabulary shared by protocol, host, and client packages. */

/** Stable machine-readable rejection reasons; the set is closed and ordered by owning layer. */
export type PeerErrorReason =
  | 'INVALID_URI'
  | 'INVALID_PAYLOAD'
  | 'CORRUPT_INSTANCE'
  | 'INVALID_HELLO'
  | 'STORE_FAILED'
  | 'PEER_UNAVAILABLE_VM'
  | 'RECORD_NOT_FOUND'
  | 'TRANSPORT_FAILED'
  | 'ENROLLMENT_REJECTED'
  | 'REDEEM_REJECTED'
  | 'EXCHANGE_FAILED'
  | 'HELLO_REJECTED'
  | 'IDENTITY_MISMATCH'
  | 'UNSUPPORTED_CREDENTIALS'
  | 'CHALLENGE_EXPIRED'
  | 'INVALID_PROOF'
  | 'SURFACE_DENIED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'PIN_MISMATCH'

/** One carrier-level peer failure with a closed reason and no secret material. */
export class PeerError extends Error {
  /** Closed rejection reason; clients match on this value, never on `message`. */
  readonly reason: PeerErrorReason
  /**
   * @param reason - closed rejection reason.
   * @param detail - optional non-secret context appended to the message.
   */
  constructor(reason: PeerErrorReason, detail?: string) {
    super(`peer: ${reason}${detail === undefined ? '' : ` (${detail})`}`)
    this.reason = reason
  }
}
