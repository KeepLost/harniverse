# @deepseek-ai/dsh-peer-client

English | [中文](README.zh.md)

The initiating side of instance pairing: the per-home P-256 signing identity, the `peer-targets.json` store, the enroll-redeem-hello orchestration, and the delegate/follow-up/enumeration calls. A pure library — no plugin, no Config — consumed by [dsh-peer-app](../../bundle/peer-app/README.md); a future live-channel plugin will compose it the same way.

## Signing identity

`ensurePeerIdentityKey(home)` loads or mints `peers/identity.pem`, one PKCS#8 P-256 key per home with owner-only permissions, and returns the base64url SPKI public material plus an IEEE-P1363 SHA-256 signing callback. The key enrolls once per target; possession is proven through the standard challenge exchange (`GrantAccess` from [dsh-sdk-client](../../sdk/client/README.md)).

## Pairing orchestration

`pairWithPeer({ invite, home, origin, fetch?, timeoutMs?, transport? })` runs the complete flow against one target: ensure identity and key, then either reuse the recorded active Grant (idempotent re-pairing skips enrollment entirely) or enroll under `peer-<instanceId>`, redeem the invitation, and keep the approved Grant id. Every run then exchanges a signed challenge for a short Access Token, fetches one `peer/challenge` nonce, and invokes `peer/hello` with the signature over `(instanceId, nonce)` through the Connection RPC envelope, aborting with `IDENTITY_MISMATCH` when the target answers a different identity than the invitation asserted. The persisted target records endpoint, transport, grant name and id, and status in `peer-targets.json`.

## Delegation calls

`runPeerDelegate`, `runPeerFollowup`, and `runPeerSessions` share `{ target, home, origin }` options and a resolved `{ instanceId, key }` identity: each call mints a timestamp-windowed request proof, rebuilds `GrantAccess` from the stored Grant id, and posts through the same envelope. Wire failures carrying code `peer-failed` map back to the closed peer reason (`SURFACE_DENIED`, `INVALID_PROOF`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, …); readbacks are re-validated before use.

Each stage reports a closed reason: `TRANSPORT_FAILED`, `ENROLLMENT_REJECTED`, `REDEEM_REJECTED`, `HELLO_REJECTED`, `IDENTITY_MISMATCH`, `CHALLENGE_EXPIRED`, `INVALID_PROOF`, `SURFACE_DENIED`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `STORE_FAILED`. The origin must be HTTPS or loopback HTTP, matching the invitation codec's rule.

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

- Idempotent re-pairing reuses the recorded Grant; if the target revoked it, the exchange fails and the operator must re-invite after removing the stale target record.
- The Access Token is process-memory only; a live-channel plugin owns renewal across long-lived connections later.
- Delegation calls are synchronous: a `state: 'running'` result leaves the turn alive on the target and the caller re-asks through `sessions`; no initiator-side durable outbox queues prompts while the target is unreachable.
