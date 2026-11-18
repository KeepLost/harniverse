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
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
  surface: PeerSurface
  /** How the peer was admitted; the shipped flow is always the invitation token. */
  pairedVia: 'invitation'
  status: 'active' | 'revoked'
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
