/** Initiating side of instance pairing: identity keys, target store, and the enroll-redeem-hello orchestration. */
export type * from './types.ts'
export { type PeerKeyMaterial, ensurePeerIdentityKey, peerIdentityKeyPath } from './keys.ts'
export { findPeerTarget, parsePeerTarget, peerTargetsPath, readPeerTargets, writePeerTargets } from './targets.ts'
export { type PairOptions, pairWithPeer } from './pairing.ts'
