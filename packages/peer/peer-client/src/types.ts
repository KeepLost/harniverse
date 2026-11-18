/** Client-side peer types. No runtime code lives in this module. */
import type { PeerHello, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'

export type { PeerEndpoint, PeerHello, PeerInstanceId, PeerInvitePayload, PeerTarget, PeerTargetFile, PeerTransport } from '@deepseek-ai/dsh-peer-protocol'

/** Complete outcome of one successful pairing run. */
export interface PeerPairingResult {
  /** The target's identity as verified by `peer/hello` readback. */
  hello: PeerHello
  /** The approved Grant id on the target; challenge exchanges mint short tokens from it. */
  grantId: string
  /** The local target record as persisted. */
  target: PeerTarget
}
