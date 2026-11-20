/** Host-side peer store and service types. No runtime code lives in this module. */
import type { PeerInstanceId, PeerRecord, PeerSurface } from '@deepseek-ai/dsh-peer-protocol'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Emitted after one peer's first `peer/hello` appended its record.
     * @mode emit
     * @param record - the committed paired-peer record.
     */
    'peer/paired'(record: PeerRecord): void
    /**
     * Emitted after one paired-peer record was removed from the store.
     * @mode emit
     * @param record - the removed record's final state.
     */
    'peer/removed'(record: PeerRecord): void
  }
}
export type { PeerEndpoint, PeerHello, PeerHelloInput, PeerInstanceId, PeerRecord, PeerSessionSummary, PeerStoreFile, PeerSurface, PeerSurfaceRequest, PeerSurfaceResult, PeerTarget, PeerTargetFile, PeerTransport } from '@deepseek-ai/dsh-peer-protocol'

/** Home-relative peer store configuration. */
export interface PeerHostConfig {
  /** Harness home holding `instance.json` and `peers.json`; defaults to standard resolution. */
  dshHome?: string
}

/** Owner-facing governance view of one paired peer. */
export interface PeerAdminView {
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
  status: 'active' | 'revoked'
  /** Surface currently in force. */
  surface: PeerSurface
  /** Complete desired surface parked by a widening peer request, awaiting owner decision. */
  pendingSurface?: PeerSurface
  firstSeenAt: string
  lastSeenAt: string
  /** Monthly delivered-turn cap; absent means unlimited. */
  monthlyTurns?: number
  /** Delivered turns in the labeled period. */
  monthlyTurnsUsed: number
  monthlyTurnPeriod: string
  /** Delegated sessions currently on record for this peer. */
  sessionCount: number
}
