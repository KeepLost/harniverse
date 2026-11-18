/** Host-side peer store and service types. No runtime code lives in this module. */
export type { PeerEndpoint, PeerHello, PeerHelloInput, PeerInstanceId, PeerRecord, PeerStoreFile, PeerSurface, PeerTarget, PeerTargetFile, PeerTransport } from '@deepseek-ai/dsh-peer-protocol'

/** Home-relative peer store configuration. */
export interface PeerHostConfig {
  /** Harness home holding `instance.json` and `peers.json`; defaults to standard resolution. */
  dshHome?: string
}
