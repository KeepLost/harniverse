# @deepseek-ai/dsh-peer-host

English | [中文](README.zh.md)

The accepting side of instance pairing: the capability-gated `peer/*` Remotes — challenge/hello pairing with pinned identity keys, plus delegated sessions, follow-up delivery, and per-peer enumeration — and the paired-peer store. `PeerHost` is the default-exported `TypertRemoteService` at `ctx.peerHost`, wire namespace `peer`, composed in the web-app bundle. Injections: none required — agent registry, presets, and model services resolve through `ctx.get` and delegation fails closed with `SESSION_BUSY` when the composition ships none.

## Remote surface

| Method | Wire arguments | Capability | Result |
| --- | --- | --- | --- |
| `cancel(request)` | `{ request: PeerCancelRequest }` | `harniverse.peer` | `PeerRunResult` |
| `challenge()` | `{}` | `harniverse.peer` | `{ challenge }` |
| `hello(request)` | `{ request: PeerHelloRequest }` | `harniverse.peer` | `PeerHello` |
| `delegate(request)` | `{ request: PeerDelegateRequest }` | `harniverse.peer` | `PeerRunResult` |
| `followup(request)` | `{ request: PeerFollowupRequest }` | `harniverse.peer` | `PeerRunResult` |
| `result(request)` | `{ request: PeerResultRequest }` | `harniverse.peer` | `PeerRunResult` |
| `sessions(request)` | `{ request: PeerSessionsRequest }` | `harniverse.peer` | `{ sessions: PeerSessionSummary[] }` |
| `subscribe(request)` | `{ request: PeerSessionsRequest }` | `harniverse.peer` | `PeerSubscribeResult` |
| `upload(request)` | `{ request: PeerUploadBeginRequest }` | `harniverse.peer` | `PeerUploadBeginResult` |
| `append(request)` | `{ request: PeerUploadAppendRequest }` | `harniverse.peer` | `PeerUploadAppendResult` |
| `download(request)` | `{ request: PeerDownloadRequest }` | `harniverse.peer` | `PeerDownloadResult` |

`challenge` mints one single-use nonce (five-minute TTL, bounded outstanding set). `hello` verifies the initiator's signature over `(instanceId, challenge)`, pins the base64url SPKI `identityPublicKey` into the record at first pairing, and verifies every later hello against the pinned key — a different key answers `IDENTITY_MISMATCH`, a spent or unknown nonce `CHALLENGE_EXPIRED`. Records without a pinned key (pre-proof era) pin on their first proof-bearing hello. The first record for an id emits `peer/paired`; a revoked record rejects `HELLO_REJECTED`. Every call refuses `PEER_UNAVAILABLE_VM` inside a VM execution world, and the web-app composition disables the row entirely under `$DSH_EXEC_WORLD === 'vm'`, so real-sandbox instances never pair.

`delegate`, `followup`, `cancel`, `result`, `subscribe`, and `sessions` authenticate the caller's nonce-bearing request proof against the pinned key, then gate on the matching `PeerSurface` field (`SURFACE_DENIED` otherwise). A proof's nonce is consumed on first use — a capture replayed inside the skew window answers `INVALID_PROOF (replayed nonce)`. `delegate` composes one `peer-<uuid>` session with `origin: 'peer'` and a working directory resolved under `peer-work/<instanceId>/` (relative paths only; escapes reject `INVALID_PAYLOAD`), delivers the prompt through the agent inbox, and awaits turn settlement up to the requested budget — settling returns the concatenated assistant text and end reason, expiring returns `state: 'running'` with the session id. `followup` delivers the next FIFO turn into a session the same caller owns (`SESSION_NOT_FOUND` otherwise), cold-resuming it when no agent is resident. `cancel` aborts the current turn of one owned, resident session (`delegate` surface): a running turn is cancelled with the user cause and returns its terminal state, an idle session returns its newest claim's settlement unchanged, and a non-resident session answers `SESSION_NOT_FOUND`. `result` reads one owned turn's settlement without delivering another prompt — it re-derives the terminal state, reply, and end reason from the live session log or, for a cold session, the persisted events, answering `running` while the turn is still outstanding; the read gates on the `list` surface. `sessions` lists that caller's entries with live `running`/`idle`/`ended` state. `subscribe` (also `list`-gated) mints one single-use stream token redeemable at the event-stream route within `PEER_STREAM_TOKEN_TTL_MS`. `surface` (proof-authenticated like the rest) takes one complete desired surface: a pure narrowing commits on the spot and retires any parked request, while any widening parks the complete desire in the record's single `pendingSurface` slot — latest request wins, no expiry, and calls keep answering under the surface in force until the owner decides. Closed failures ride the wire as `RemoteError` code `peer-failed` with `details.reason` carrying the peer reason verbatim.

The artifact verbs ride the same message discipline — the peer line is communication, never a storage side door. `upload` validates the manifest against this deployment's own attachment file limits (no generic-file support answers `ATTACHMENT_REFUSED`; the deployment cap answers `ATTACHMENT_TOO_LARGE`) and reserves one slot in the transient staging area `.peer-uploads/<peerId>/` (fifteen-minute TTL, swept each minute, cleared at host start — in-flight transport state only). `append` carries one canonical-base64 chunk by absolute offset, metering its bytes against the peer's monthly `monthlyBytes` budget before any byte lands, and seals the slot when its complete bytes match the manifest digest (`DIGEST_MISMATCH` drops it whole). A `delegate` or `followup` request admits sealed slots through `uploads` (at most four): each digest is re-verified, the bytes commit through this instance's own attachment pipeline (`saveFile`), and the delivered message carries the durable references in its source plus a read-only handle block naming the file for the model's read tool — storage policy and retention stay entirely this side's own attachment configuration. `download` reads one bounded workspace file (sixteen-MiB single frame) from the caller's own peer root, refusing absolute or escaping paths, and its delivered bytes meter into the same bucket. All three verbs require the surface's `artifacts` grant.

## Event stream

When a web server is composed, the service registers the exact route `GET /api/peer/events?token=<streamToken>` — exact routes take precedence over the shared `/api` prefix, and the unguessable single-use token minted by `peer/subscribe` is the route's entire authentication. The stream serves one `text/event-stream` response per subscribed peer: `turn/end` events of that peer's own sessions push `{"kind":"settled","sessionId}` data frames, and heartbeat comments flow at `PEER_STREAM_HEARTBEAT_MS` (the tick also refreshes the owned-session filter from the registry). Frames are wake-up signals only — settlements are confirmed through `peer/result`; a refused or broken stream changes nothing for the caller. Tokens are single-use: every reconnect re-subscribes through the authenticated Remote, so a fresh nonce-bearing proof precedes each stream.

## Stores

`peers.json` under the home is the authority for paired peers: strict-shape validation, insertion-order records, atomic owner-only writes through `writePeerStore`. `peer-sessions.json` holds the delegated-session registry the same way. The `peer/paired` and `peer/removed` events are live-process observations; out-of-band CLI mutations do not emit them. `removePeer(instanceId)` deletes one record, drops that peer's registry entries, closes its resident agents from true idle, and emits `peer/removed`; the packaged CLI revokes the matching grant separately.

## Events

`peer/paired(record: PeerRecord)` and `peer/removed(record: PeerRecord)` are emitted in the serving process only, after the store commit. The package invariant asserts each emitted transition is reflected in the store file.

## Verification

From the repository root:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-host/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-host
```

## Model Experience

### Delegated turns

#### What the model sees

One `peer/delegate` or `peer/followup` prompt arrives as an ordinary user message inside the delegated session's own log; the agent runs the same turn it would for a local prompt of the same text, with no peer-specific markers on the model-visible surface.

#### Token effect

Identical to a local prompt of the same text; the accepting instance's own sessions never see peer prompts.

#### KV Cache effect

Each delegated session carries its own conversation and cache prefix, so a peer turn never reuses or evicts a local session's prefix.

## Known Limitations and Deferred Work

- `removePeer` closes a busy delegated agent only from true idle; a running turn finishes before its session record disappears.
- The owner governance Remotes (`list`, `removePeer`, `setSurface`, `approveSurface`, `rejectSurface`, `setBudget`, `audit`) share the `peer` namespace behind the `harniverse.administer` capability; turn budgets live in `peer-governance.json` as optional per-peer monthly caps counted in accepted delivered turns, answering `BUDGET_EXCEEDED` once the period's cap is reached. Removal emits no stream frame: the paired side learns from its next failing call.
- The pending surface slot carries no expiry; a newer widening request replaces it, and owner edits, approval, rejection, or a peer-side narrowing commit clear it.
- The event stream holds no replay cursor: a frame lost to a dropped connection is recovered by the next `peer/result` read, not by stream resumption; each reconnect mints a fresh token through a fresh proof.
- Consumed-nonce retention is bounded per peer; a burst beyond the bound ages the oldest nonces out of replay protection inside the skew window.
