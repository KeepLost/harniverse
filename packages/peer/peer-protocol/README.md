# @deepseek-ai/dsh-peer-protocol

English | [中文](README.zh.md)

Shared peer vocabulary: the `dsh-peer:` invitation codec, the home-anchored instance identity, the hello and request proofs, the closed error vocabulary, and the grant-name convention. A pure library — no plugin, no Config, no registration — consumed by [dsh-peer-host](../peer-host/README.md), [dsh-peer-client](../peer-client/README.md), and [dsh-peer-app](../../bundle/peer-app/README.md).

## Instance identity

Each DSH home mints one `instance.json` on first peer use — `{ version, instanceId, displayName, platform, arch, createdAt }` with a lowercase-UUID id, written atomically with owner-only permissions. `ensureInstanceIdentity(home)` reads or mints; `readInstanceIdentity(home)` rejects missing or malformed documents with `CORRUPT_INSTANCE`. The id is stable for the home's lifetime; the signing key that proves it lives with the initiator ([dsh-peer-client](../peer-client/README.md)), not here.

## Invitation codec

`encodePeerInvite(payload)` produces the single-paste `dsh-peer://<base64url>` URI; `decodePeerInvite(uri)` validates the complete shape — version, lowercase-UUID id, bounded display name, an origin that is HTTPS or loopback HTTP, a `dshi1_` token, and an optional base64 SHA-256 TLS fingerprint — rejecting closed reasons `INVALID_URI` and `INVALID_PAYLOAD`. `peerGrantName(instanceId)` derives the registry-unique `peer-<instanceId>` name and `instanceIdOfGrantName` reads it back; the shared display-name bound is `isDisplayName`.

## Proofs

Two canonical signatures bind Remote calls to the initiator's P-256 identity key. The hello proof covers `peerHelloMessage(instanceId, challenge)` — the single-use nonce minted by `peer/challenge` — so the accepting instance pins `identityPublicKey` into the paired record at first pairing and verifies every later hello against the pinned key (`IDENTITY_MISMATCH` otherwise). The request proof covers `peerRequestMessage(instanceId, timestamp, nonce)`; `verifyPeerRequestProof` checks shape, the `PEER_PROOF_SKEW_MS` clock window, and the signature against the pinned key, and returns the proof's nonce so the host rejects any replay inside the window. `verifyPeerSignature` is the shared base64url-SPKI ECDSA/SHA-256 verifier both proofs use. Stream constants ride along: `PEER_STREAM_TOKEN_TTL_MS` bounds one minted event-stream token's redeemability and `PEER_STREAM_HEARTBEAT_MS` names the cadence the stream maintains; `PEER_NONCE_TTL_MS` is the host-side retention horizon for consumed request nonces.

## Artifact wire vocabulary

File artifacts ride the message channel, never a storage side door. One upload begins with a `PeerUploadManifest` (`name`, optional `mediaType`, exact `bytes`, base64url `sha256`); the accepting side reserves a transient staging slot and answers with its own `maxChunkBytes` and, when it accepts generic files, its `maxFileBytes`. Chunks append in order by `offset` and canonical base64, and a delegate or follow-up request admits completed slots through `PeerUploadRef` entries — the accepting side re-verifies each digest before the artifact enters its session pipeline. `PeerDownloadRequest` reads one bounded workspace file back through `PeerDownloadResult`. The closed reasons `ATTACHMENT_REFUSED`, `ATTACHMENT_TOO_LARGE`, `UPLOAD_NOT_FOUND`, and `DIGEST_MISMATCH` name the artifact failure family; every artifact-bearing call requires the surface's `artifacts` grant.

## Verification

From the repository root:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-protocol/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-protocol
```

## Model Experience

None, as this library registers no tools, prompts, or Session events; pairing surfaces belong to the host and client packages.

#### KV Cache effect

None; the package assembles no model input.

## Known Limitations and Deferred Work

- The identity document carries no key material; a future key-rotation path replaces the initiator key through revoke-and-re-pair rather than extending this format.
- TLS fingerprint pinning applies only when the invitation carries one; an unpinned HTTPS origin still relies on Node trust roots, and a pinned origin rejects plain-HTTP dials outright.
