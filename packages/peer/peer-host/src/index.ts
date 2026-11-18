/** Accepting side of instance pairing: capability-gated identity readback and the paired-peer store. */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  FULL_PEER_SURFACE,
  PeerError,
  isDisplayName,
  peerInstanceId,
  readInstanceIdentity,
} from '@deepseek-ai/dsh-peer-protocol'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { PeerHello, PeerHelloInput, PeerInstanceId, PeerRecord } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerHostConfig } from './types.ts'
import { findPeer, readPeerStore, writePeerStore } from './store.ts'

const { version: PEER_HOST_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

export type * from './types.ts'
export { findPeer, parsePeerRecord, peerStorePath, readPeerStore, writePeerStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { peerHost: PeerHost }
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

/** Peer acceptance service; the store file is the authority and events are live-process observations. */
export class PeerHost extends TypertRemoteService {
  static Config: z<PeerHostConfig> = z.object({ dshHome: z.string() })

  /** Resolved Harness home holding the identity file and the peer store. */
  readonly home: string

  constructor(ctx: Context, config: PeerHostConfig = {}) {
    super(ctx, 'peerHost', { namespace: 'peer' })
    this.home = resolveDshHome(config.dshHome)
  }

  /** Answer one authenticated peer's identity readback and commit its paired record.
   * @param identity - the initiator's self-asserted home identity.
   * @returns this instance's identity and the approved surface.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async hello(identity: PeerHelloInput): Promise<PeerHello> {
    assertPairableWorld()
    const input = validateHello(identity)
    const self = await readInstanceIdentity(this.home)
    const peers = await readPeerStore(this.home)
    const now = new Date().toISOString()
    const existing = findPeer(peers, input.instanceId)
    if (existing?.status === 'revoked') throw new PeerError('HELLO_REJECTED', 'peer is revoked')
    const record: PeerRecord = {
      instanceId: input.instanceId,
      displayName: input.displayName,
      platform: input.platform,
      arch: input.arch,
      version: input.version,
      surface: { ...FULL_PEER_SURFACE },
      pairedVia: 'invitation',
      status: 'active',
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    }
    await writePeerStore(this.home, [...peers.filter(peer => peer.instanceId !== input.instanceId), record])
    if (existing === undefined) this.ctx.emit('peer/paired', record)
    return {
      instanceId: self.instanceId,
      displayName: self.displayName,
      platform: self.platform,
      arch: self.arch,
      version: PEER_HOST_VERSION,
      surface: { ...FULL_PEER_SURFACE },
    }
  }

  /** Remove one paired-peer record and report the removed record's final state.
   * @param instanceId - exact instance id to remove.
   * @returns the removed record.
   * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
   */
  async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord> {
    const peers = await readPeerStore(this.home)
    const existing = findPeer(peers, instanceId)
    if (existing === undefined) throw new PeerError('RECORD_NOT_FOUND')
    await writePeerStore(this.home, peers.filter(peer => peer.instanceId !== instanceId))
    this.ctx.emit('peer/removed', existing)
    return existing
  }
}

/** Reject pairing inside a VM execution world; peers never serve from real-sandbox instances. */
function assertPairableWorld(): void {
  if (process.env.DSH_EXEC_WORLD === 'vm') throw new PeerError('PEER_UNAVAILABLE_VM')
}

/** Validate one self-asserted hello identity against the shared bounds.
 * @param value - untrusted wire value.
 * @returns the validated identity.
 */
function validateHello(value: unknown): PeerHelloInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_HELLO')
  const record = value as unknown as Record<string, unknown>
  const keys = ['instanceId', 'displayName', 'platform', 'arch', 'version']
  if (keys.length !== Object.keys(record).length || keys.some(key => !(key in record))) throw new PeerError('INVALID_HELLO')
  if (typeof record.instanceId !== 'string') throw new PeerError('INVALID_HELLO')
  peerInstanceId(record.instanceId)
  if (!isDisplayName(record.displayName)) throw new PeerError('INVALID_HELLO')
  if (typeof record.platform !== 'string' || record.platform.length === 0 || record.platform.length > 32
    || typeof record.arch !== 'string' || record.arch.length === 0 || record.arch.length > 16
    || typeof record.version !== 'string' || record.version.length === 0 || record.version.length > 32) {
    throw new PeerError('INVALID_HELLO')
  }
  return value as unknown as PeerHelloInput
}

export default PeerHost
