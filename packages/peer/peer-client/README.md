# @deepseek-ai/dsh-peer-client

English | [中文](README.zh.md)

The initiating side of instance pairing: the per-home P-256 signing identity, the `peer-targets.json` store, the enroll-redeem-hello orchestration, the delegation and cancellation calls, and the event-stream reader. A pure library — no plugin, no Config — consumed by [dsh-peer-app](../../bundle/peer-app/README.md) and [dsh-peer-outbox](../peer-outbox/README.md).

## Signing identity

`ensurePeerIdentityKey(home)` loads or mints `peers/identity.pem`, one PKCS#8 P-256 key per home with owner-only permissions, and returns the base64url SPKI public material plus an IEEE-P1363 SHA-256 signing callback. The key enrolls once per target; possession is proven through the standard challenge exchange (`GrantAccess` from [dsh-sdk-client](../../sdk/client/README.md)).

## Pairing orchestration

`pairWithPeer({ invite, home, origin, fetch?, timeoutMs?, transport? })` runs the complete flow against one target: ensure identity and key, then either reuse the recorded active Grant (idempotent re-pairing skips enrollment entirely) or enroll under `peer-<instanceId>`, redeem the invitation, and keep the approved Grant id. Every run then exchanges a signed challenge for a short Access Token, fetches one `peer/challenge` nonce, and invokes `peer/hello` with the signature over `(instanceId, nonce)` through the Connection RPC envelope, aborting with `IDENTITY_MISMATCH` when the target answers a different identity than the invitation asserted. The persisted target records endpoint, transport, grant name and id, TLS pin, and status in `peer-targets.json`. A target carrying `tlsFingerprint` must be dialed over HTTPS: `pinnedFetchFor` builds the transport fetch with a `checkServerIdentity` that rejects any certificate not hashing to the pin (`PIN_MISMATCH`), and SSH forwards accept `https://127.0.0.1:<port>` endpoints so the same verification rides the tunnel; an unpinned target keeps Node trust roots.

## Delegation calls

`runPeerDelegate`, `runPeerFollowup`, `runPeerCancel`, `runPeerResult`, `runPeerSessions`, and `runPeerSubscribe` share `{ target, home, origin }` options and a resolved `{ instanceId, key }` identity: each call mints a single-use nonce-bearing request proof, rebuilds `GrantAccess` from the stored Grant id, and posts through the same envelope. Wire failures carrying code `peer-failed` map back to the closed peer reason (`SURFACE_DENIED`, `INVALID_PROOF`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, …); readbacks are re-validated before use. `runPeerResult` reads one owned turn's settlement by session and message id without delivering a new prompt; `runPeerCancel` aborts the current turn of one owned session and returns its terminal state; `runPeerSubscribe` mints the single-use stream token; `runPeerSurface` delivers one complete desired surface and reports the surface in force plus whether the desire is pending owner approval.

`openPeerEventStream({ target, home, origin, fetch?, signal }, streamToken, onFrame)` reads the subscribed `text/event-stream` to its end or abort: it parses `data:` frames through `parsePeerEventFrame`, ignores heartbeat comments, ends quietly when the abort fires, and reports refused streams and malformed frames as `TRANSPORT_FAILED`. A Grant whose challenge or token exchange the target rejects — a revoked Grant on re-pair — surfaces as `EXCHANGE_FAILED` carrying the remove-and-re-invite guidance instead of a raw sdk-client error; transport-level throws classify as `TRANSPORT_FAILED` (or `HELLO_REJECTED` during pairing) so callers classify reachability once.

Each stage reports a closed reason: `TRANSPORT_FAILED`, `ENROLLMENT_REJECTED`, `REDEEM_REJECTED`, `EXCHANGE_FAILED`, `HELLO_REJECTED`, `IDENTITY_MISMATCH`, `CHALLENGE_EXPIRED`, `INVALID_PROOF`, `SURFACE_DENIED`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `PIN_MISMATCH`, `STORE_FAILED`. The origin must be HTTPS or loopback HTTP, matching the invitation codec's rule.

## Verification

From the repository root:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-client/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-client
```

## Model Experience

None, as this library registers no tools, prompts, or Session events; the initiating surface reaches models through the future delegation and messaging packages.

#### KV Cache effect

None; the package assembles no model input.

## Known Limitations and Deferred Work

- Idempotent re-pairing reuses the recorded Grant; a revoked Grant answers `EXCHANGE_FAILED` and the operator must re-invite after removing the stale target record — no silent re-enrollment exists.
- The Access Token is process-memory only; every new call rebuilds `GrantAccess`, and the event stream carries no token renewal — each reconnect re-subscribes through a fresh proof.
- Delegation calls are synchronous: a `state: 'running'` result leaves the turn alive on the target and the caller re-asks through `result`; queueing prompts while the target is unreachable stays forbidden by the pairing contract.
- The pinned fetch verifies the certificate on every dialed connection but performs no certificate transparency or OCSP checks.
