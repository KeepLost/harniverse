# Peer

English | [中文](peer.zh.md)

Instance pairing connects two Harniverse homes so one instance's model can later delegate and message sessions on the other, each running in its own environment. Pairing itself exchanges no task data: it establishes one authenticated principal, two durable records, and one identity-verified channel anchor. A home is the identity anchor — one `instance.json`, one P-256 signing key, one session corpus — and the exclusive home lease already guarantees one running process per home.

Service Definition: [dsh-peer-host](../../packages/peer/peer-host) (`ctx.peerHost` + the `peer/*` Remote namespace and events). Shared vocabulary and home-anchored identity live in [dsh-peer-protocol](../../packages/peer/peer-protocol); the initiating orchestration, target store, and shared transport dialing live in [dsh-peer-client](../../packages/peer/peer-client); the model-facing `peer` tool is [dsh-tool-peer](../../packages/peer/tool-peer); the `dsh peer` management app is [dsh-peer-app](../../packages/bundle/peer-app). Design rationale lives in [the instance pairing Agent Note](../../.agents/notes/implemented/feature/2026-11-18-peer-instance-pairing.md) and [the peer tool Agent Note](../../.agents/notes/implemented/feature/2026-11-19-peer-tool.md).

Sources: [`packages/peer/peer-protocol/src/types.ts`](../../packages/peer/peer-protocol/src/types.ts), [`packages/peer/peer-protocol/src/payload.ts`](../../packages/peer/peer-protocol/src/payload.ts), [`packages/peer/peer-protocol/src/proof.ts`](../../packages/peer/peer-protocol/src/proof.ts), [`packages/peer/peer-host/src/index.ts`](../../packages/peer/peer-host/src/index.ts), and [`packages/peer/peer-host/src/delegate.ts`](../../packages/peer/peer-host/src/delegate.ts)

## Pairing flow

The accepting instance's owner runs `dsh peer invite --endpoint <origin>`, which mints the home's identity on first use, issues one one-time `dshi1_` enrollment invitation scoped to the `harniverse.peer` capability, and prints a single-paste `dsh-peer:` URI carrying the endpoint, the target identity, an optional TLS fingerprint, and the token. The initiator pastes the URI into `dsh peer add`: it enrolls its own home's public key under the `peer-<instanceId>` grant name, redeems the invitation (possession acts as approval), exchanges a signed challenge for a short Access Token, fetches one `peer/challenge` nonce, and calls `peer/hello` with a signature over `(instanceId, nonce)`. The target pins that public key into the paired record at first pairing and verifies every later hello against it — a different key answers `IDENTITY_MISMATCH` — and answers with its own identity; a mismatch with the invitation's asserted identity aborts pairing, so both records pin each other's home identity. The invitation token is bootstrap-only and separate from the durable grant credential.

Every `peer/*` Remote requires the `harniverse.peer` capability; an unpaired caller holds no capability and every call fails closed. Grants are created as `api-client` kind with exactly that one capability, and the deterministic `peer-<instanceId>` name plus the registry's name-uniqueness make grant-name squatting across peers impossible: first pairing owns the name.

## Records and identity

The accepting instance persists paired peers in `peers.json` under its home; the initiator persists targets in `peer-targets.json` under its own home. Both files are the authority — the `peer/paired` and `peer/removed` events are live-process observations for future UI, not durable state. `peer remove` deletes the record and revokes the matching grant; the target's historical sessions stay in its own corpus.

```ts type-equiv
/** Paired-peer record persisted by the accepting instance. */
interface PeerRecord {
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
```

```ts type-equiv
/** Peer capability surface approved at pairing; each field gates one Remote family. */
interface PeerSurface {
  /** The peer may start and continue delegated sessions on this instance. */
  delegate: boolean
  /** The peer may deliver messages into sessions it owns on this instance. */
  message: boolean
  /** The peer may enumerate sessions it owns on this instance. */
  list: boolean
  /** The peer may carry file artifacts with its messages and fetch its workspace files. */
  artifacts: boolean
}
```

```ts type-equiv
/** Stable identity of one Harness home: a minted UUID in canonical lowercase form, validated at every boundary. */
type PeerInstanceId = string
```

```ts type-equiv
/** Timestamp-windowed signature authenticating one peer Remote request. */
interface PeerRequestProof {
  /** The caller's home-anchored identity; resolves the pinned record. */
  instanceId: PeerInstanceId
  /** Claim time in epoch milliseconds; the host rejects values outside the skew window. */
  timestamp: number
  /** Single-use nonce minted per request; the host rejects any replayed nonce inside the skew window. */
  nonce: string
  /** Base64url IEEE-P1363 ECDSA/SHA-256 signature over the canonical request message. */
  signature: string
}
```

```ts type-equiv
/** Result of one delegate or follow-up call. */
interface PeerRunResult {
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
```

The `peer/hello` Remote carries the initiator's self-asserted identity plus its hello proof and returns the target's; both sides validate the shared bounds (display name 1–64 non-control characters, bounded platform/arch/version strings) and reject closed-reason errors from the [peer vocabulary](../../packages/peer/peer-protocol).

## Delegation

`peer/delegate`, `peer/followup`, and `peer/sessions` run real sessions on the accepting instance for the paired initiator. Every request carries a timestamp-windowed request proof signed by the pinned identity key; the host resolves the calling record from the proof before checking the matching surface field, so a peer can only ever reach its own sessions. `peer/delegate` composes one `origin: 'peer'` session whose working directory resolves under `peer-work/<instanceId>/` (relative paths only) and delivers the prompt through the agent inbox; settlement is observed from the session's own event window, returning the concatenated assistant text and end reason, or `state: 'running'` past the budget. `peer/followup` delivers the next FIFO turn the same way, cold-resuming the session when no agent is resident; `peer/sessions` lists the caller's registry entries with derived `running`/`idle`/`ended` state. Sessions with `origin: 'peer'` stay out of every user-facing session list; they are reachable only through the peer Remotes.

Removing a peer drops its session registry entries and closes its resident agents from true idle; `dsh peer run/send/sessions` on the initiator resolve the stored transport — direct origins dial as-is, `ssh` transports forward to the target's loopback port for the call's lifetime.

The initiating side's model reaches the same channel through the first-party `peer` tool ([dsh-tool-peer](../../packages/peer/tool-peer)): it resolves a paired target by display name or instance id, delivers the prompt through `peer/delegate` or `peer/followup` within a bounded settlement budget, and renders the settled reply naming the session id; a turn still running past the budget reports continuation guidance instead of blocking. The tool adds no reachability of its own — it dials exactly the targets the home's owner paired, and the accepting surface fields still gate every Remote family.


`peer/result` is the read-only settlement companion: it re-derives one owned turn's terminal state, reply, and end reason from the live session log — or, for a cold session, the persisted events — without delivering another prompt, answering `state: 'running'` while the turn is still outstanding. It gates on the `list` surface and exists so settlement reads never need a throwaway model turn. `peer/cancel` (`delegate` surface) closes the loop on the initiator's side: it aborts the current turn of one owned, resident session with the user cause and returns its terminal state — an idle session reports its newest claim's settlement unchanged, and a non-resident session answers `SESSION_NOT_FOUND`, so cancellation never fabricates work.

Every request proof now carries a single-use nonce covered by the signature: the host consumes the nonce on first use and rejects any replay inside the skew window, closing the ±90s capture-replay window the timestamp-only proof left open.

## Settlement ledger

Delegation is a both-online contract: an unreachable target fails immediately, and the initiator's settlement ledger ([dsh-peer-outbox](../../packages/peer/peer-outbox), `ctx.peerOutbox`, web-app composition) never queues unsent work. It tracks exactly the turns an online target already accepted but that outran the tool's budget: the tool registers such a turn durably, and the instance-resident watcher reads its settlement through `peer/result` every poll interval. A transient transport fault gets exactly one immediate re-probe; a second fault fails the entry (`TARGET_UNREACHABLE`) — the ledger waits for no one. A settled turn delivers its truncated reply into the initiating session as one `peer`-sourced queued user message through the idle maintenance phase, in submission order per session; a session that is no longer live fails the entry with the reply retained for `dsh peer outbox`. Because the ledger is durable storage, an instance restart resumes every watch on its next poll. Terminal entries are bounded to a retention window, and `dsh peer run/send --async` submit with the minimum budget and print the receipt that `dsh peer result` reads back; `dsh peer cancel` aborts a running turn on the target and settles its entry through the same channel.

## Event stream

`peer/subscribe` (proof-authenticated, `list`-gated) mints one single-use stream token; the exact route `GET /api/peer/events?token=…` — registered by `peer-host` whenever a web server is composed, taking precedence over the shared `/api` prefix — serves one `text/event-stream` per subscribed peer. The stream pushes a `{"kind":"settled","sessionId"}` frame for each `turn/end` of that peer's own sessions and heartbeats comments at a fixed cadence; the token is the route's entire authentication, so every reconnect passes a fresh nonce-bearing proof. The channel is deliberately one-way and advisory: frames are wake-up signals that poke an immediate settlement read, never a second source of truth — the outbox keeps its standing poll as the fallback, a refused stream changes nothing, and no mechanism queues work for a target that is offline. Upstream requests (delivery, cancellation, renewal) stay ordinary authenticated Remote calls, so the channel adds reachability to nothing.

## Transport pinning

An invitation may pin the target's TLS certificate by its base64 SHA-256 fingerprint. A pinned target must be dialed over HTTPS — directly, or through an SSH forward whose invitation endpoint is `https://127.0.0.1:<port>`: the client builds its transport fetch with a `checkServerIdentity` that rejects any certificate not hashing to the pin (`PIN_MISMATCH`), and the verification rides the same TLS connection either way. A pinned target dialed over plain HTTP fails before any bytes leave; an unpinned HTTPS origin keeps Node trust roots.

## Governance

The accepting instance owns the governance surface. Its owner-administered Remotes — `list`, `removePeer`, `setSurface`, `approveSurface`, `rejectSurface`, `setBudget`, `audit` — ride the same `peer` namespace behind the `harniverse.administer` capability, so peer tokens cannot reach them; the web dashboard's Paired peers tab (`ui-peer-admin`) consumes them through the mounted client contract and re-lists on the forwarded `peer/paired` / `peer/removed` events.

Surface changes follow the approval flow: an owner edit commits immediately, while a peer's own `peer/surface` request states one complete desired surface — a pure narrowing (or an equal surface) commits on the spot and retires any parked request, but any widening parks the complete desired surface in the record's single `pendingSurface` slot, latest request winning, with no expiry. While a request pends, calls keep answering under the surface in force; approval commits the parked surface, rejection drops it, and the peer observes the outcome from the next `peer/surface` call or the denials on other families.

Turn budgets live in `peer-governance.json`: one optional per-peer monthly cap counted in accepted delivered turns (`delegate` first turns and `followup` turns alike), in UTC calendar months, unlimited when unset. The gate runs before delivery — a capped `delegate` mints no session and a capped `followup` checks before the session lookup — and the count is recorded once the turn is accepted for delivery, whatever its settlement later says; concurrently in-flight deliveries can overshoot by at most their own count, and the rejection is `BUDGET_EXCEEDED` naming the period and the limit; artifact chunks and download bytes meter into the same `peer-governance.json` entry's monthly `monthlyBytes` bucket. The admin `audit` answers metadata-only session rows (live state, timestamps, creation label); transcripts stay in the normal session view, and the rows live for the pairing's lifetime — removal ends the peer's delegated sessions, drops its governance entry, and emits `peer/removed`; the paired side learns of a removal when its next call no longer resolves the record, by design no stream frame announces it.

## Artifacts

File artifacts ride the message channel — the peer line is communication, never a side door into either side's storage. One artifact upload starts with `peer/upload`, whose manifest (`name`, optional `mediaType`, exact `bytes`, base64url `sha256`) the accepting side validates against its own deployment file limits, refusing with `ATTACHMENT_REFUSED` when it accepts no generic files and `ATTACHMENT_TOO_LARGE` past its own cap; the begin result advertises the accepting side's `maxChunkBytes` and `maxFileBytes` so an initiator fails fast without transferring. Ordered `peer/append` calls carry canonical-base64 chunks by absolute offset into a transient staging area (`.peer-uploads/<peerId>/`, fifteen-minute TTL, swept each minute, cleared at host start — pure in-flight transport state, never durable configuration), and a slot seals only when its complete bytes match the manifest digest, else it drops with `DIGEST_MISMATCH`.

A `delegate` or `followup` request admits sealed slots through its `uploads` list (at most four); the accepting side re-verifies each digest, then commits the bytes through its own attachment pipeline (`saveFile`) and delivers the message with the durable references in its source and a read-only handle block naming the file for the target model's read tool. Storage policy, retention, and caps stay entirely the accepting side's own attachment configuration — the peer layer owns none of them, and artifacts belong to the sessions that admitted them, not to the pairing: `removePeer` clears pairing and governance, never session artifacts.

The reverse lane is `peer/download`: it reads one bounded workspace file (sixteen MiB single-frame cap, `ATTACHMENT_TOO_LARGE` beyond) from the caller's own peer root, refusing absolute or escaping paths, and answers with the bytes, their length, and a digest the initiator verifies before use. Both directions require the surface's `artifacts` grant and meter against the same governance entry: every carried chunk on append and every delivered download byte count into the peer's monthly `monthlyBytes` bucket beside its turn counts, with the identical `BUDGET_EXCEEDED` rejection — so a byte-capped peer is stopped before any byte lands, not after.

## Transports and exclusion

The invitation endpoint is an HTTPS origin, or loopback HTTP behind a tunnel — the same rule every authenticated origin follows. `dsh peer add` dials the endpoint directly, or through one remote-hosts SSH record (`--ssh-host`) that forwards to the target's loopback port; key-file and agent logins work headless, encrypted credential references do not. A VM execution world composes no `peer-host` row and the service refuses `peer/hello` from VM homes, so real-sandbox instances never join the pairing fabric.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeerhost--peerhost"></a>

### `ctx.peerHost` — `PeerHost`

Peer acceptance service; the store file is the authority and events are live-process observations.

```ts cordis-catalog
/** Mint one single-use pairing challenge for the hello proof exchange.
 * @returns the nonce to sign and its lifetime boundary.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async challenge(): Promise<{ challenge: string }>

/** Answer one authenticated peer's identity readback and commit its pinned paired record.
 * @param request - the initiator's identity plus its challenge signature.
 * @returns this instance's identity and the approved surface.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async hello(request: PeerHelloRequest): Promise<PeerHello>

/** Remove one paired-peer record, end its delegated sessions, and report the removed record.
 * @param instanceId - exact instance id to remove.
 * @returns the removed record.
 * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
 */
async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord>

/** Start one delegated session for the calling peer and await its first settlement.
 * @param request - proof, prompt, and optional working directory, profile, and budget.
 * @returns the minted session and its first turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async delegate(request: PeerDelegateRequest): Promise<PeerRunResult>

/** Deliver the next turn into one session the calling peer owns.
 * @param request - proof, session id, prompt, and optional budget.
 * @returns the delivered turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async followup(request: PeerFollowupRequest): Promise<PeerRunResult>

/** Read one owned turn's settlement without delivering another prompt.
 * @param request - proof, session id, and the accepted turn's message id.
 * @returns the observed turn state, reply, and end reason.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async result(request: PeerResultRequest): Promise<PeerRunResult>

/** Enumerate the calling peer's own delegated sessions.
 * @param request - proof of the calling peer.
 * @returns the caller's session summaries, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async sessions(request: { proof: PeerRequestProof }): Promise<{ sessions: PeerSessionSummary[] }>

/** Cancel the current turn of one session the calling peer owns.
 * @param request - proof and the caller's own session id.
 * @returns the cancelled turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async cancel(request: PeerCancelRequest): Promise<PeerRunResult>

/** Mint one single-use event-stream token for the calling peer.
 * @param request - proof of the calling peer.
 * @returns the stream token and the heartbeat cadence.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async subscribe(request: { proof: PeerRequestProof }): Promise<PeerSubscribeResult>

/** Request one surface change: a pure narrowing commits immediately, any widening parks for owner approval.
 * @param request - proof plus the complete desired surface.
 * @returns the surface in force and whether the desire is pending owner approval.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async surface(request: PeerSurfaceRequest): Promise<PeerSurfaceResult>

/** Reserve one transient staging slot for one artifact upload.
 * @param request - proof plus the complete upload manifest.
 * @returns the staging slot id and this deployment's own chunk and file caps.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async upload(request: PeerUploadBeginRequest): Promise<PeerUploadBeginResult>

/** Append one ordered chunk to a staged upload, metering the carried bytes against the peer's budget.
 * @param request - proof, slot id, absolute offset, and canonical base64 chunk.
 * @returns bytes held after the append and whether the slot sealed against its digest.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async append(request: PeerUploadAppendRequest): Promise<PeerUploadAppendResult>

/** Read one bounded workspace file from the caller's peer root in a single frame.
 * @param request - proof plus the relative path inside the caller's workspace.
 * @returns the file's digest-bearing readback; the carried bytes count against the peer's budget.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async download(request: PeerDownloadRequest): Promise<PeerDownloadResult>

/** List every paired peer with its governance state for the owner admin surface.
 * @returns admin views, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async list(): Promise<{ peers: PeerAdminView[] }>

/** Remove one paired peer, end its delegated sessions, and drop its governance entry.
 * @param input - exact instance id to remove.
 */
@Remote({ requiredCapability: 'harniverse.administer', exportName: 'removePeer' }) async remove(input: { instanceId: PeerInstanceId }): Promise<void>

/** Set the granted surface directly; the owner's own decision needs no approval step.
 * @param input - exact instance id and the complete new surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async setSurface(input: { instanceId: PeerInstanceId; surface: PeerSurface }): Promise<PeerAdminView>

/** Commit the parked widening surface a peer requested.
 * @param input - exact instance id carrying a pending surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async approveSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView>

/** Drop the parked widening surface a peer requested; the surface in force stays unchanged.
 * @param input - exact instance id carrying a pending surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async rejectSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView>

/** Set or lift one peer's monthly budgets.
 * @param input - exact instance id and the new caps; an absent cap lifts that budget.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async setBudget(input: { instanceId: PeerInstanceId; monthlyTurns?: number; monthlyBytes?: number }): Promise<PeerAdminView>

/** Audit one peer's delegated sessions; metadata only, transcripts stay in the session view.
 * @param input - exact instance id to audit.
 * @returns the peer's session summaries, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async audit(input: { instanceId: PeerInstanceId }): Promise<{ sessions: PeerSessionSummary[] }>
```

Source: [`packages/peer/peer-host/src/index.ts:69`](../../packages/peer/peer-host/src/index.ts)

<a id="ctxpeeroutbox--peeroutbox"></a>

### `ctx.peerOutbox` — `PeerOutbox`

Peer outbox service; the storage-domain ledger is the authority.

```ts cordis-catalog
/**
 * All ledger entries, earliest submission first.
 * @returns every stored entry.
 */
list(): PeerOutboxEntry[]

/**
 * Track one accepted-but-running delegated turn. The entry is durable from
 * this call onward: an instance restart resumes the watch on its next poll.
 * @param input - target, peer session, watched turn, and owner session.
 * @returns the stored entry.
 */
async track(input: PeerOutboxTrackInput): Promise<PeerOutboxEntry>
```

Source: [`packages/peer/peer-outbox/src/index.ts:60`](../../packages/peer/peer-outbox/src/index.ts)

<a id="peer-events"></a>

### `peer/*` events

<a id="peerpaired--emit"></a>

#### `peer/paired` — emit

Emitted after one peer's first `peer/hello` appended its record.

```ts cordis-catalog
/**
 * Emitted after one peer's first `peer/hello` appended its record.
 * @mode emit
 * @param record - the committed paired-peer record.
 */
'peer/paired'(record: PeerRecord): void
```

Source: [`packages/peer/peer-host/src/types.ts:11`](../../packages/peer/peer-host/src/types.ts)

<a id="peerremoved--emit"></a>

#### `peer/removed` — emit

Emitted after one paired-peer record was removed from the store.

```ts cordis-catalog
/**
 * Emitted after one paired-peer record was removed from the store.
 * @mode emit
 * @param record - the removed record's final state.
 */
'peer/removed'(record: PeerRecord): void
```

Source: [`packages/peer/peer-host/src/types.ts:17`](../../packages/peer/peer-host/src/types.ts)
<!-- END GENERATED cordis-surface -->
