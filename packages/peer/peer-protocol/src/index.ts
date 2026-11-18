/** Shared peer vocabulary: invite codec, home-anchored identity, closed errors, and naming conventions. */
export type * from './types.ts'
export { PeerError, type PeerErrorReason } from './errors.ts'
export {
  DEFAULT_INVITE_TTL_MS,
  FULL_PEER_SURFACE,
  PEER_CAPABILITY,
  PEER_ENROLLMENT_KIND,
  PEER_INVITE_SCHEME,
  decodePeerInvite,
  encodePeerInvite,
  instanceIdOfGrantName,
  isDisplayName,
  newPeerInstanceId,
  peerGrantName,
  peerInstanceId,
  validateOrigin,
  validatePeerInvite,
} from './payload.ts'
export {
  type InstanceIdentity,
  ensureInstanceIdentity,
  instanceIdentityPath,
  parseInstanceIdentity,
  readInstanceIdentity,
  writeInstanceIdentity,
} from './instance.ts'
