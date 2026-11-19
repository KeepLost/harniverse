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

/** Enumerate the calling peer's own delegated sessions.
 * @param request - proof of the calling peer.
 * @returns the caller's session summaries, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async sessions(request: { proof: PeerRequestProof }): Promise<{ sessions: PeerSessionSummary[] }>
```

Source: [`packages/peer/peer-host/src/index.ts:52`](../../packages/peer/peer-host/src/index.ts)

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

Source: [`packages/peer/peer-host/src/index.ts:41`](../../packages/peer/peer-host/src/index.ts)

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

Source: [`packages/peer/peer-host/src/index.ts:47`](../../packages/peer/peer-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
