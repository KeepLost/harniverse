/** Accepting side of instance pairing: capability-gated identity readback and the paired-peer store. */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  FULL_PEER_SURFACE,
  PEER_CHALLENGE_TTL_MS,
  PeerError,
  isDisplayName,
  peerHelloMessage,
  peerInstanceId,
  readInstanceIdentity,
  verifyPeerRequestProof,
  verifyPeerSignature,
} from '@deepseek-ai/dsh-peer-protocol'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { PeerAdminView, PeerHostConfig } from './types.ts'
import type {
  PeerCancelRequest,
  PeerDelegateRequest,
  PeerDownloadRequest,
  PeerDownloadResult,
  PeerFollowupRequest,
  PeerHello,
  PeerHelloInput,
  PeerHelloRequest,
  PeerInstanceId,
  PeerRecord,
  PeerRequestProof,
  PeerResultRequest,
  PeerRunResult,
  PeerSessionSummary,
  PeerSubscribeResult,
  PeerSurface,
  PeerSurfaceRequest,
  PeerSurfaceResult,
  PeerUploadAppendRequest,
  PeerUploadAppendResult,
  PeerUploadBeginRequest,
  PeerUploadBeginResult,
} from '@deepseek-ai/dsh-peer-protocol'
import { cancelPeerSession, delegateToPeer, downloadPeerFile, dropPeerSessions, followupPeerSession, listPeerSessions, resultPeerSession, validateCancelRequest, validateDelegateRequest, validateFollowupRequest, validateResultRequest, validateSessionsRequest, validateSubscribeRequest } from './delegate.ts'
import { authorizePeerBytes, PEER_BUDGET_MAX_BYTES, PEER_BUDGET_MAX_TURNS, isNarrowing, peerBudgetView, recordPeerBytes, setPeerBudget } from './governance.ts'
import { PeerNonceLedger, PeerStreamTokens, runPeerEventStream } from './events.ts'
import { appendStagedUpload, beginStagedUpload, clearStagingUploads, sweepStagingUploads, validateUploadManifest, PEER_CHUNK_MAX_BYTES } from './staging.ts'
import { findPeer, readPeerStore, writePeerStore } from './store.ts'
import { readPeerSessions } from './session-registry.ts'

const { version: PEER_HOST_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Upper bound on simultaneously outstanding pairing challenges. */
const MAX_PENDING_CHALLENGES = 256

/** Exact path serving the peer event stream; exact routes take precedence over the `/api` prefix. */
const PEER_EVENT_STREAM_PATH = '/api/peer/events'

export type * from './types.ts'
export { findPeer, parsePeerRecord, peerStorePath, readPeerStore, writePeerStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { peerHost: PeerHost }
}

/** Peer acceptance service; the store file is the authority and events are live-process observations. */
export class PeerHost extends TypertRemoteService {
  static Config: z<PeerHostConfig> = z.object({ dshHome: z.string() })

  /** Resolved Harness home holding the identity file and the peer store. */
  readonly home: string

  /** Outstanding single-use pairing challenges by nonce. */
  private readonly pendingChallenges = new Map<string, number>()

  /** Single-use stream tokens for the event channel. */
  private readonly streamTokens = new PeerStreamTokens()

  /** Consumed request-proof nonces; the replay half of the skew-window closure. */
  private readonly nonceLedger = new PeerNonceLedger()

  constructor(ctx: Context, config: PeerHostConfig = {}) {
    super(ctx, 'peerHost', { namespace: 'peer' })
    this.home = resolveDshHome(config.dshHome)
  }

  /** @inheritdoc */
  protected [Service.init](): void {
    // One restart invalidates every in-flight upload; staging is transport state, never durable.
    void clearStagingUploads(this.home)
    /* v8 ignore next 4 -- the periodic sweeper reaps TTL-expired slots in production; unit tests sweep directly */
    const sweeper = setInterval(() => {
      void sweepStagingUploads(this.home, Date.now())
    }, 60_000)
    ;(sweeper as { unref?: () => void }).unref?.()
    this.ctx.effect(() => {
      return () => {
        clearInterval(sweeper)
      }
    })
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) return
    const route: WebRoute = {
      kind: 'exact',
      path: PEER_EVENT_STREAM_PATH,
      handler: async (req, res) => {
        await this.serveEventStream(req, res)
      },
    }
    this.ctx.effect(() => webServer.register(route), 'peer-host: peer event stream route')
  }

  /** Serve one event-stream request: redeem the single-use token, then stream until the client leaves.
   * @param req - the incoming stream request.
   * @param res - the response the stream owns.
   */
  private async serveEventStream(req: { method?: string | undefined; url?: string | undefined }, res: {
    writeHead(status: number, headers: Record<string, string>): unknown
    write(chunk: string): unknown
    end(): unknown
    on(event: 'close', listener: () => void): unknown
  }): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (req.method !== 'GET') {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end()
      return
    }
    const token = url.searchParams.get('token')
    const instanceId = token === null ? undefined : this.streamTokens.redeem(token, Date.now())
    if (instanceId === undefined) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const close = new AbortController()
    res.on('close', () => {
      close.abort()
    })
    await runPeerEventStream({
      ctx: this.ctx, home: this.home, instanceId,
      write: (chunk) => {
        res.write(chunk)
      },
      signal: close.signal,
    })
    res.end()
  }

  /** Mint one single-use pairing challenge for the hello proof exchange.
   * @returns the nonce to sign and its lifetime boundary.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async challenge(): Promise<{ challenge: string }> {
    return await this.remote(() => {
      assertPairableWorld()
      const now = Date.now()
      for (const [nonce, expiresAt] of this.pendingChallenges) {
        if (expiresAt <= now) this.pendingChallenges.delete(nonce)
      }
      if (this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
        this.pendingChallenges.delete(this.pendingChallenges.keys().next().value as string)
      }
      const challenge = randomBytes(24).toString('base64url')
      this.pendingChallenges.set(challenge, now + PEER_CHALLENGE_TTL_MS)
      return { challenge }
    })
  }

  /** Run one Remote body, carrying the closed peer reasons onto the wire.
   * @param body - the Remote method's body.
   * @returns the body's result.
   */
  private async remote<T>(body: () => T | Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      /* v8 ignore next 2 -- every body failure maps onto PeerError; the passthrough guards internal defects */
      if (!(error instanceof PeerError)) throw error
      throw new RemoteError('peer-failed', error.message, { reason: error.reason })
    }
  }

  /** Answer one authenticated peer's identity readback and commit its pinned paired record.
   * @param request - the initiator's identity plus its challenge signature.
   * @returns this instance's identity and the approved surface.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async hello(request: PeerHelloRequest): Promise<PeerHello> {
    return await this.remote(async () => {
      assertPairableWorld()
      const input = validateHello(request)
      const self = await readInstanceIdentity(this.home)
      const peers = await readPeerStore(this.home)
      const now = new Date().toISOString()
      const existing = findPeer(peers, input.instanceId)
      if (existing?.status === 'revoked') throw new PeerError('HELLO_REJECTED', 'peer is revoked')
      const pinned = existing?.identityPublicKey
      const verifyingKey = pinned ?? request.proof.publicKey
      if (!this.consumeChallenge(request.challenge)) throw new PeerError('CHALLENGE_EXPIRED')
      if (pinned !== undefined && pinned !== request.proof.publicKey) throw new PeerError('IDENTITY_MISMATCH')
      if (!verifyPeerSignature(verifyingKey, peerHelloMessage(input.instanceId, request.challenge), request.proof.signature)) {
        throw new PeerError('INVALID_PROOF')
      }
      const record: PeerRecord = {
        instanceId: input.instanceId,
        displayName: input.displayName,
        platform: input.platform,
        arch: input.arch,
        version: input.version,
        surface: existing?.surface ?? { ...FULL_PEER_SURFACE },
        pairedVia: 'invitation',
        status: 'active',
        identityPublicKey: pinned ?? request.proof.publicKey,
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
        surface: record.surface,
      }
    })
  }

  /** Remove one paired-peer record, end its delegated sessions, and report the removed record.
   * @param instanceId - exact instance id to remove.
   * @returns the removed record.
   * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
   */
  async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord> {
    const peers = await readPeerStore(this.home)
    const existing = findPeer(peers, instanceId)
    if (existing === undefined) throw new PeerError('RECORD_NOT_FOUND')
    await writePeerStore(this.home, peers.filter(peer => peer.instanceId !== instanceId))
    await dropPeerSessions(this.ctx, this.home, instanceId)
    this.ctx.emit('peer/removed', existing)
    return existing
  }

  /** Redeem one minted challenge exactly once.
   * @param challenge - the nonce presented by the hello proof.
   * @returns whether the nonce was outstanding and unexpired.
   */
  private consumeChallenge(challenge: string): boolean {
    const expiresAt = this.pendingChallenges.get(challenge)
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      if (expiresAt !== undefined) this.pendingChallenges.delete(challenge)
      return false
    }
    this.pendingChallenges.delete(challenge)
    return true
  }

  /** Resolve and authenticate the calling peer of one Remote request.
   * @param proof - untrusted request proof from the wire.
   * @returns the verified record.
   */
  private async authenticate(proof: PeerRequestProof): Promise<PeerRecord> {
    const peers = await readPeerStore(this.home)
    const record = findPeer(peers, proof.instanceId)
    if (record === undefined) throw new PeerError('RECORD_NOT_FOUND')
    if (record.status === 'revoked') throw new PeerError('HELLO_REJECTED', 'peer is revoked')
    const nonce = verifyPeerRequestProof(proof, record.identityPublicKey, Date.now())
    // First use of a nonce wins; a capture replayed inside the skew window rejects here.
    if (!this.nonceLedger.consume(record.instanceId, nonce, Date.now())) {
      throw new PeerError('INVALID_PROOF', 'replayed nonce')
    }
    return record
  }

  /** Start one delegated session for the calling peer and await its first settlement.
   * @param request - proof, prompt, and optional working directory, profile, and budget.
   * @returns the minted session and its first turn's terminal state.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async delegate(request: PeerDelegateRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateDelegateRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.delegate) throw new PeerError('SURFACE_DENIED', 'delegate')
      return await delegateToPeer(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Deliver the next turn into one session the calling peer owns.
   * @param request - proof, session id, prompt, and optional budget.
   * @returns the delivered turn's terminal state.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async followup(request: PeerFollowupRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateFollowupRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.message) throw new PeerError('SURFACE_DENIED', 'message')
      return await followupPeerSession(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Read one owned turn's settlement without delivering another prompt.
   * @param request - proof, session id, and the accepted turn's message id.
   * @returns the observed turn state, reply, and end reason.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async result(request: PeerResultRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateResultRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.list) throw new PeerError('SURFACE_DENIED', 'list')
      return await resultPeerSession(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Enumerate the calling peer's own delegated sessions.
   * @param request - proof of the calling peer.
   * @returns the caller's session summaries, newest activity first.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async sessions(request: { proof: PeerRequestProof }): Promise<{ sessions: PeerSessionSummary[] }> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateSessionsRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.list) throw new PeerError('SURFACE_DENIED', 'list')
      return { sessions: await listPeerSessions(this.ctx, this.home, record.instanceId) }
    })
  }

  /** Cancel the current turn of one session the calling peer owns.
   * @param request - proof and the caller's own session id.
   * @returns the cancelled turn's terminal state.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async cancel(request: PeerCancelRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateCancelRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.delegate) throw new PeerError('SURFACE_DENIED', 'delegate')
      return await cancelPeerSession(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Mint one single-use event-stream token for the calling peer.
   * @param request - proof of the calling peer.
   * @returns the stream token and the heartbeat cadence.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async subscribe(request: { proof: PeerRequestProof }): Promise<PeerSubscribeResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateSubscribeRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.list) throw new PeerError('SURFACE_DENIED', 'list')
      return this.streamTokens.mint(record.instanceId, Date.now())
    })
  }

  /** Request one surface change: a pure narrowing commits immediately, any widening parks for owner approval.
   * @param request - proof plus the complete desired surface.
   * @returns the surface in force and whether the desire is pending owner approval.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async surface(request: PeerSurfaceRequest): Promise<PeerSurfaceResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateSurfaceRequest(request)
      const authenticated = await this.authenticate(valid.proof)
      const peers = await readPeerStore(this.home)
      const record = findPeer(peers, authenticated.instanceId)
      /* v8 ignore next -- a concurrent removal between authenticate and this write must not resurrect the record */
      if (record === undefined) throw new PeerError('RECORD_NOT_FOUND')
      const { pendingSurface: parked, ...rest } = record
      const replace = [...peers.filter(peer => peer.instanceId !== record.instanceId)]
      if (isNarrowing(record.surface, valid.surface)) {
        // A narrowing is the peer surrendering grants; committing it also retires any parked widening.
        if (!sameSurface(record.surface, valid.surface) || parked !== undefined) {
          await writePeerStore(this.home, [...replace, { ...rest, surface: valid.surface }])
        }
        return { surface: valid.surface, pending: false }
      }
      await writePeerStore(this.home, [...replace, { ...record, pendingSurface: valid.surface }])
      return { surface: record.surface, pending: true }
    })
  }

  /** Reserve one transient staging slot for one artifact upload.
   * @param request - proof plus the complete upload manifest.
   * @returns the staging slot id and this deployment's own chunk and file caps.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async upload(request: PeerUploadBeginRequest): Promise<PeerUploadBeginResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateUploadBegin(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.artifacts) throw new PeerError('SURFACE_DENIED', 'artifacts')
      const limits = this.ctx.get('attachments')?.fileLimits
      if (limits === undefined) throw new PeerError('ATTACHMENT_REFUSED', 'generic files are not accepted here')
      const manifest = validateUploadManifest(valid.manifest, limits.maxFileBytes)
      const uploadId = await beginStagedUpload(this.home, record.instanceId, manifest)
      return { uploadId, maxChunkBytes: PEER_CHUNK_MAX_BYTES, maxFileBytes: limits.maxFileBytes }
    })
  }

  /** Append one ordered chunk to a staged upload, metering the carried bytes against the peer's budget.
   * @param request - proof, slot id, absolute offset, and canonical base64 chunk.
   * @returns bytes held after the append and whether the slot sealed against its digest.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async append(request: PeerUploadAppendRequest): Promise<PeerUploadAppendResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateUploadAppend(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.artifacts) throw new PeerError('SURFACE_DENIED', 'artifacts')
      const data = decodeCanonicalBase64(valid.dataBase64)
      await authorizePeerBytes(this.home, record.instanceId, new Date(), data.byteLength)
      const outcome = await appendStagedUpload(this.home, record.instanceId, valid.uploadId, valid.offset, data)
      await recordPeerBytes(this.home, record.instanceId, new Date(), data.byteLength)
      return outcome
    })
  }

  /** Read one bounded workspace file from the caller's peer root in a single frame.
   * @param request - proof plus the relative path inside the caller's workspace.
   * @returns the file's digest-bearing readback; the carried bytes count against the peer's budget.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async download(request: PeerDownloadRequest): Promise<PeerDownloadResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateDownloadRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.artifacts) throw new PeerError('SURFACE_DENIED', 'artifacts')
      const outcome = await downloadPeerFile(this.home, record.instanceId, valid)
      await recordPeerBytes(this.home, record.instanceId, new Date(), outcome.bytes)
      return outcome
    })
  }

  /** List every paired peer with its governance state for the owner admin surface.
   * @returns admin views, newest activity first.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async list(): Promise<{ peers: PeerAdminView[] }> {
    return await this.remote(async () => {
      const peers = await readPeerStore(this.home)
      const sessions = await readPeerSessions(this.home)
      const views: PeerAdminView[] = []
      for (const record of peers) {
        const budget = await peerBudgetView(this.home, record.instanceId, new Date())
        views.push({
          instanceId: record.instanceId, displayName: record.displayName, platform: record.platform,
          arch: record.arch, version: record.version, status: record.status, surface: record.surface,
          ...record.pendingSurface === undefined ? {} : { pendingSurface: record.pendingSurface },
          firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt,
          ...budget,
          sessionCount: sessions.filter(entry => entry.peerInstanceId === record.instanceId).length,
        })
      }
      views.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      return { peers: views }
    })
  }

  /** Remove one paired peer, end its delegated sessions, and drop its governance entry.
   * @param input - exact instance id to remove.
   */
  @Remote({ requiredCapability: 'harniverse.administer', exportName: 'removePeer' })
  async remove(input: { instanceId: PeerInstanceId }): Promise<void> {
    await this.remote(async () => {
      const { instanceId } = validateAdminTarget(input)
      await this.removePeer(instanceId)
      await setPeerBudget(this.home, instanceId, {})
    })
  }

  /** Set the granted surface directly; the owner's own decision needs no approval step.
   * @param input - exact instance id and the complete new surface.
   * @returns the updated admin view.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async setSurface(input: { instanceId: PeerInstanceId; surface: PeerSurface }): Promise<PeerAdminView> {
    return await this.remote(async () => {
      const valid = validateAdminSurface(input)
      return await this.updatePeerRecord(valid.instanceId, (record) => {
        const { pendingSurface: parked, ...rest } = record
        void parked
        return { ...rest, surface: valid.surface }
      })
    })
  }

  /** Commit the parked widening surface a peer requested.
   * @param input - exact instance id carrying a pending surface.
   * @returns the updated admin view.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async approveSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView> {
    return await this.remote(async () => {
      const { instanceId } = validateAdminTarget(input)
      return await this.updatePeerRecord(instanceId, (record) => {
        if (record.pendingSurface === undefined) throw new PeerError('RECORD_NOT_FOUND', 'no pending surface')
        const { pendingSurface, ...rest } = record
        return { ...rest, surface: pendingSurface }
      })
    })
  }

  /** Drop the parked widening surface a peer requested; the surface in force stays unchanged.
   * @param input - exact instance id carrying a pending surface.
   * @returns the updated admin view.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async rejectSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView> {
    return await this.remote(async () => {
      const { instanceId } = validateAdminTarget(input)
      return await this.updatePeerRecord(instanceId, (record) => {
        if (record.pendingSurface === undefined) throw new PeerError('RECORD_NOT_FOUND', 'no pending surface')
        const { pendingSurface: parked, ...rest } = record
        void parked
        return rest
      })
    })
  }

  /** Set or lift one peer's monthly budgets.
   * @param input - exact instance id and the new caps; an absent cap lifts that budget.
   * @returns the updated admin view.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async setBudget(input: { instanceId: PeerInstanceId; monthlyTurns?: number; monthlyBytes?: number }): Promise<PeerAdminView> {
    return await this.remote(async () => {
      const valid = validateSetBudget(input)
      const peers = await readPeerStore(this.home)
      const record = findPeer(peers, valid.instanceId)
      if (record === undefined) throw new PeerError('RECORD_NOT_FOUND')
      await setPeerBudget(this.home, valid.instanceId,
        { ...valid.monthlyTurns === undefined ? {} : { monthlyTurns: valid.monthlyTurns },
          ...valid.monthlyBytes === undefined ? {} : { monthlyBytes: valid.monthlyBytes } })
      return await this.adminViewOf(record)
    })
  }

  /** Audit one peer's delegated sessions; metadata only, transcripts stay in the session view.
   * @param input - exact instance id to audit.
   * @returns the peer's session summaries, newest activity first.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async audit(input: { instanceId: PeerInstanceId }): Promise<{ sessions: PeerSessionSummary[] }> {
    return await this.remote(async () => {
      const { instanceId } = validateAdminTarget(input)
      const peers = await readPeerStore(this.home)
      if (findPeer(peers, instanceId) === undefined) throw new PeerError('RECORD_NOT_FOUND')
      return { sessions: await listPeerSessions(this.ctx, this.home, instanceId) }
    })
  }

  /** Build the admin view of one stored record.
   * @param record - the stored paired-peer record.
   * @returns the governance view with budget and session counts.
   */
  private async adminViewOf(record: PeerRecord): Promise<PeerAdminView> {
    const [budget, sessions] = await Promise.all([peerBudgetView(this.home, record.instanceId, new Date()), readPeerSessions(this.home)])
    return {
      instanceId: record.instanceId, displayName: record.displayName, platform: record.platform,
      arch: record.arch, version: record.version, status: record.status, surface: record.surface,
      ...record.pendingSurface === undefined ? {} : { pendingSurface: record.pendingSurface },
      firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt,
      ...budget,
      sessionCount: sessions.filter(entry => entry.peerInstanceId === record.instanceId).length,
    }
  }

  /** Apply one owner edit to a stored record and return its admin view.
   * @param instanceId - exact instance id to edit.
   * @param mutate - pure record transformation.
   * @returns the admin view of the committed record.
   * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
   */
  private async updatePeerRecord(instanceId: PeerInstanceId, mutate: (record: PeerRecord) => PeerRecord): Promise<PeerAdminView> {
    const peers = await readPeerStore(this.home)
    const record = findPeer(peers, instanceId)
    if (record === undefined) throw new PeerError('RECORD_NOT_FOUND')
    const updated = mutate(record)
    await writePeerStore(this.home, [...peers.filter(peer => peer.instanceId !== instanceId), updated])
    return await this.adminViewOf(updated)
  }
}

/** Reject pairing inside a VM execution world; peers never serve from real-sandbox instances. */
function assertPairableWorld(): void {
  if (process.env.DSH_EXEC_WORLD === 'vm') throw new PeerError('PEER_UNAVAILABLE_VM')
}

/** Whether two surfaces agree on every field.
 * @param left - one complete surface.
 * @param right - the other complete surface.
 * @returns whether all four grants match.
 */
function sameSurface(left: PeerSurface, right: PeerSurface): boolean {
  return left.delegate === right.delegate && left.message === right.message
    && left.list === right.list && left.artifacts === right.artifacts
}

/** Validate the strict four-boolean surface shape.
 * @param value - untrusted surface value.
 * @returns the validated surface.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed surfaces.
 */
function requireSurface(value: unknown): PeerSurface {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD', 'surface')
  const surface = value as Record<string, unknown>
  if (Object.keys(surface).length !== 4 || typeof surface.delegate !== 'boolean'
    || typeof surface.message !== 'boolean' || typeof surface.list !== 'boolean'
    || typeof surface.artifacts !== 'boolean') {
    throw new PeerError('INVALID_PAYLOAD', 'surface')
  }
  return value as PeerSurface
}

/** Validate one surface-change request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateSurfaceRequest(value: unknown): PeerSurfaceRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (typeof record.proof !== 'object' || record.proof === null || Array.isArray(record.proof)) throw new PeerError('INVALID_PAYLOAD')
  requireSurface(record.surface)
  return value as PeerSurfaceRequest
}

/** Validate one admin request naming a single instance id.
 * @param value - untrusted wire value.
 * @returns the validated target.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateAdminTarget(value: unknown): { instanceId: PeerInstanceId } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)) {
    throw new PeerError('INVALID_PAYLOAD', 'instanceId')
  }
  return value as { instanceId: PeerInstanceId }
}

/** Validate one admin surface edit's shape.
 * @param value - untrusted wire value.
 * @returns the validated target and surface.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateAdminSurface(value: unknown): { instanceId: PeerInstanceId; surface: PeerSurface } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2) throw new PeerError('INVALID_PAYLOAD')
  validateAdminTarget({ instanceId: record.instanceId })
  requireSurface(record.surface)
  return value as { instanceId: PeerInstanceId; surface: PeerSurface }
}

/** Validate one budget edit's shape.
 * @param value - untrusted wire value.
 * @returns the validated target and optional caps.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateSetBudget(value: unknown): { instanceId: PeerInstanceId; monthlyTurns?: number; monthlyBytes?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some(key => key !== 'instanceId' && key !== 'monthlyTurns' && key !== 'monthlyBytes')) {
    throw new PeerError('INVALID_PAYLOAD', 'fields')
  }
  validateAdminTarget({ instanceId: record.instanceId })
  if (record.monthlyTurns !== undefined && (typeof record.monthlyTurns !== 'number' || !Number.isInteger(record.monthlyTurns)
    || record.monthlyTurns < 1 || record.monthlyTurns > PEER_BUDGET_MAX_TURNS)) {
    throw new PeerError('INVALID_PAYLOAD', 'monthlyTurns out of range')
  }
  if (record.monthlyBytes !== undefined && (typeof record.monthlyBytes !== 'number' || !Number.isInteger(record.monthlyBytes)
    || record.monthlyBytes < 1 || record.monthlyBytes > PEER_BUDGET_MAX_BYTES)) {
    throw new PeerError('INVALID_PAYLOAD', 'monthlyBytes out of range')
  }
  return value as { instanceId: PeerInstanceId; monthlyTurns?: number; monthlyBytes?: number }
}

/** Validate one upload-begin request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateUploadBegin(value: unknown): PeerUploadBeginRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.proof !== 'object' || record.proof === null
    || Array.isArray(record.proof) || typeof record.manifest !== 'object' || record.manifest === null
    || Array.isArray(record.manifest)) {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return value as PeerUploadBeginRequest
}

/** Validate one upload-append request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateUploadAppend(value: unknown): PeerUploadAppendRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4 || typeof record.proof !== 'object' || record.proof === null
    || Array.isArray(record.proof) || typeof record.uploadId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.uploadId)
    || !Number.isInteger(record.offset) || (record.offset as number) < 0
    || typeof record.dataBase64 !== 'string' || record.dataBase64.length === 0
    || record.dataBase64.length > Math.ceil(PEER_CHUNK_MAX_BYTES * 4 / 3) + 4) {
    throw new PeerError('INVALID_PAYLOAD', 'append fields')
  }
  return value as PeerUploadAppendRequest
}

/** Validate one workspace download request's shape.
 * @param value - untrusted wire value.
 * @returns the validated request.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed requests.
 */
function validateDownloadRequest(value: unknown): PeerDownloadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.proof !== 'object' || record.proof === null
    || Array.isArray(record.proof) || typeof record.path !== 'string' || record.path.length === 0
    || record.path.length > 512 || record.path.includes('\0')) {
    throw new PeerError('INVALID_PAYLOAD', 'download fields')
  }
  return value as PeerDownloadRequest
}

/** Decode one canonical-base64 chunk, rejecting non-canonical encodings.
 * @param data - the wire encoding.
 * @returns the decoded bytes.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for non-canonical base64.
 */
function decodeCanonicalBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) throw new PeerError('INVALID_PAYLOAD', 'chunk is not canonical base64')
  return new Uint8Array(decoded)
}

/** Validate one hello request against the shared bounds.
 * @param value - untrusted wire value.
 * @returns the validated identity.
 */
function validateHello(value: unknown): PeerHelloInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_HELLO')
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).length !== 3 || typeof envelope.challenge !== 'string'
    || envelope.challenge.length === 0 || envelope.challenge.length > 128
    || typeof envelope.identity !== 'object' || envelope.identity === null || Array.isArray(envelope.identity)
    || typeof envelope.proof !== 'object' || envelope.proof === null || Array.isArray(envelope.proof)) {
    throw new PeerError('INVALID_HELLO')
  }
  const proof = envelope.proof as Record<string, unknown>
  if (Object.keys(proof).length !== 2 || typeof proof.publicKey !== 'string' || proof.publicKey.length === 0
    || typeof proof.signature !== 'string' || proof.signature.length === 0) {
    throw new PeerError('INVALID_HELLO')
  }
  const record = envelope.identity as Record<string, unknown>
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
  return record as unknown as PeerHelloInput
}

export default PeerHost
