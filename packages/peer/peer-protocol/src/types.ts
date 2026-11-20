/** Shared peer vocabulary types. No runtime code lives in this module. */
/** Stable identity of one Harness home: a minted UUID in canonical lowercase form, validated at every boundary. */
export type PeerInstanceId = string

/** Peer capability surface approved at pairing; each field gates one Remote family. */
export interface PeerSurface {
  /** The peer may start and continue delegated sessions on this instance. */
  delegate: boolean
  /** The peer may deliver messages into sessions it owns on this instance. */
  message: boolean
  /** The peer may enumerate sessions it owns on this instance. */
  list: boolean
}

/** Origin one paired initiator dials: `https://host:port`, or loopback `http://127.0.0.1:port` behind a tunnel. */
export interface PeerEndpoint {
  /** Absolute origin without path, query, credentials, or fragment. */
  origin: string
}

/** Transport the initiator uses to reach the endpoint. */
export type PeerTransport =
  | { kind: 'direct' }
  | { kind: 'ssh'; /** Name of the initiator-side remote-hosts record that dials and forwards. */ host: string }

/** Invitation payload minted by `peer invite` and pasted to the initiator. */
export interface PeerInvitePayload {
  version: 1
  /** The target instance's home-anchored identity, pinned by the initiator at pairing. */
  instanceId: PeerInstanceId
  /** Target display name recorded by the initiator. */
  displayName: string
  /** Where the initiator reaches the target. */
  endpoint: PeerEndpoint
  /** SHA-256 fingerprint of the target's TLS certificate, base64url, when the origin is HTTPS. */
  tlsFingerprint?: string
  /** One-time `dshi1_` enrollment invitation token; possession acts as pairing approval. */
  token: string
}

/** Self-asserted initiator identity carried by `peer/hello`. */
export interface PeerHelloInput {
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
}

/** Signature binding one hello to the initiator's pinned identity key. */
export interface PeerHelloProof {
  /** Base64url DER SubjectPublicKeyInfo of the initiator's signing key. */
  publicKey: string
  /** Base64url IEEE-P1363 ECDSA/SHA-256 signature over the canonical hello message. */
  signature: string
}

/** Hello request: the self-asserted identity plus its cryptographic proof. */
export interface PeerHelloRequest {
  /** The single-use nonce minted by `peer/challenge` that the signature covers. */
  challenge: string
  identity: PeerHelloInput
  proof: PeerHelloProof
}

/** Timestamp-windowed signature authenticating one peer Remote request. */
export interface PeerRequestProof {
  /** The caller's home-anchored identity; resolves the pinned record. */
  instanceId: PeerInstanceId
  /** Claim time in epoch milliseconds; the host rejects values outside the skew window. */
  timestamp: number
  /** Single-use nonce minted per request; the host rejects any replayed nonce inside the skew window. */
  nonce: string
  /** Base64url IEEE-P1363 ECDSA/SHA-256 signature over the canonical request message. */
  signature: string
}

/** Delegation request: start one peer-owned session with an initial prompt. */
export interface PeerDelegateRequest {
  proof: PeerRequestProof
  /** Initial user prompt delivered as the session's first turn. */
  prompt: string
  /** Working directory relative to the caller's peer root; absent means the root itself. */
  cwd?: string
  /** Agent profile id to compose the session with; absent means the deployment default. */
  profile?: string
  /** Settlement-wait budget in milliseconds; past it the run reports `running` instead. */
  timeoutMs?: number
}

/** Follow-up request: deliver the next turn into one session the caller owns. */
export interface PeerFollowupRequest {
  proof: PeerRequestProof
  /** Session id of the caller's own delegated session. */
  sessionId: string
  /** User prompt delivered as the session's next FIFO turn. */
  prompt: string
  /** Settlement-wait budget in milliseconds; past it the run reports `running` instead. */
  timeoutMs?: number
}

/** Enumeration request for the caller's own delegated sessions. */
export interface PeerSessionsRequest {
  proof: PeerRequestProof
}

/** Settlement-read request for one turn the caller owns. */
export interface PeerResultRequest {
  proof: PeerRequestProof
  /** Session id of the caller's own delegated session. */
  sessionId: string
  /** Message id of the accepted turn whose settlement is read. */
  messageId: string
}

/** Cancellation request for the current turn of one session the caller owns. */
export interface PeerCancelRequest {
  proof: PeerRequestProof
  /** Session id of the caller's own delegated session. */
  sessionId: string
}

/** Surface-change request: the caller states a complete desired surface. */
export interface PeerSurfaceRequest {
  proof: PeerRequestProof
  /** Complete desired surface; a pure narrowing commits immediately, any expansion awaits owner approval. */
  surface: PeerSurface
}

/** Outcome of one surface-change request. */
export interface PeerSurfaceResult {
  /** The surface in force after the request; the committed narrowing, or the unchanged current surface while pending. */
  surface: PeerSurface
  /** Whether the desired surface is parked as a pending owner approval. */
  pending: boolean
}

/** Subscription grant returned by `peer/subscribe`; opens the caller's event stream. */
export interface PeerSubscribeResult {
  /** Single-use stream token redeemable once at the event-stream route inside its TTL. */
  streamToken: string
  /** Heartbeat cadence the stream maintains, in milliseconds. */
  heartbeatMs: number
}

/** One push frame on the peer event stream; a wake-up signal, never the settlement's source of truth. */
export type PeerEventFrame =
  | { kind: 'settled'; sessionId: string }

/** Terminal state of one observed turn. */
export type PeerRunState = 'settled' | 'running'

/** Result of one delegate or follow-up call. */
export interface PeerRunResult {
  /** Session id that owns the turn; safe to reference in later calls. */
  sessionId: string
  /** Accepted prompt message id. */
  messageId: string
  /** Whether the turn settled within the budget. */
  state: PeerRunState
  /** Concatenated assistant text of the turn, present once settled. */
  reply?: string
  /** Why the turn ended, present once settled; `completed` names success. */
  endReason?: string
}

/** Lifecycle state of one delegated session, derived from agent residency. */
export type PeerSessionState = 'running' | 'idle' | 'ended'

/** One delegated session row of the caller's own namespace. */
export interface PeerSessionSummary {
  sessionId: string
  createdAt: string
  lastActivityAt: string
  state: PeerSessionState
  /** Creation label: the initial prompt truncated to its first line. */
  label: string
}

/** Target identity readback returned by `peer/hello`. */
export interface PeerHello {
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
  surface: PeerSurface
}

/** Paired-peer record persisted by the accepting instance. */
export interface PeerRecord {
  /** The initiator's home-anchored identity, a minted lowercase UUID. */
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
  /** Peer capability surface approved at pairing; each field gates one Remote family. */
  surface: PeerSurface
  /** Complete desired surface parked by a peer request that widens any field; owner approval commits it. */
  pendingSurface?: PeerSurface
  /** How the peer was admitted; the shipped flow is always the invitation token. */
  pairedVia: 'invitation'
  status: 'active' | 'revoked'
  /** Base64url SPKI pinned at the first proof-bearing hello; absent only in pre-proof records. */
  identityPublicKey?: string
  firstSeenAt: string
  lastSeenAt: string
}

/** Durable file shape of the accepting instance's peer store. */
export interface PeerStoreFile { version: 1; peers: PeerRecord[] }

/** Pairing target persisted by the initiating instance. */
export interface PeerTarget {
  targetInstanceId: PeerInstanceId
  displayName: string
  endpoint: PeerEndpoint
  transport: PeerTransport
  /** Grant name convention `peer-<instanceId>` on the target. */
  grantName: string
  grantId: string
  tlsFingerprint?: string
  status: 'active' | 'revoked'
  addedAt: string
}

/** Durable file shape of the initiating instance's target store. */
export interface PeerTargetFile { version: 1; targets: PeerTarget[] }
