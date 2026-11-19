/** Durable settlement-ledger types for the initiator-side peer outbox. */

/** Closed reason families that end one ledger entry's watch. */
export type PeerOutboxFailure =
  | 'TARGET_UNREACHABLE'
  | 'TARGET_RECORD_NOT_FOUND'
  | 'SESSION_DROPPED'
  | 'OWNER_SESSION_NOT_LIVE'
  | 'READ_FAILED'

/** Lifecycle of one ledger entry. */
export type PeerOutboxState = 'watching' | 'settled' | 'failed'

/** One tracked delegated turn: accepted by an online target, still running past the tool budget. */
export interface PeerOutboxEntry {
  /** Ledger identity. */
  id: string
  /** Paired target's canonical instance id. */
  targetInstanceId: string
  /** Target display name recorded at submission time. */
  targetDisplayName: string
  /** Delegated session id on the target. */
  peerSessionId: string
  /** Message id of the accepted turn being watched. */
  messageId: string
  /** Initiating session whose inbox receives the settled reply. */
  ownerSessionId: string
  /** First line of the submitted prompt, bounded to 64 characters. */
  label: string
  /** Lifecycle state; terminal entries keep their outcome for inspection. */
  state: PeerOutboxState
  /** Epoch milliseconds the entry entered the ledger. */
  submittedAt: number
  /** Epoch milliseconds the entry reached a terminal state. */
  settledAt?: number
  /** Truncated settled reply, present once observed. */
  reply?: string
  /** Why the watched turn ended, present once settled. */
  endReason?: string
  /** Closed failure family, present on failed entries. */
  failureReason?: PeerOutboxFailure
  /** Human-readable failure detail. */
  failureDetail?: string
}

/** Input accepted by the tracking call. */
export interface PeerOutboxTrackInput {
  /** Paired target's canonical instance id. */
  targetInstanceId: string
  /** Target display name recorded for the delivery envelope. */
  targetDisplayName: string
  /** Delegated session id on the target. */
  peerSessionId: string
  /** Message id of the accepted turn being watched. */
  messageId: string
  /** Initiating session whose inbox receives the settled reply. */
  ownerSessionId: string
  /** First line of the submitted prompt, bounded to 64 characters. */
  label: string
}
