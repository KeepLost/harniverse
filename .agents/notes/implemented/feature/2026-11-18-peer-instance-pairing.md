# Instance pairing between Harniverse homes

English | [中文](2026-11-18-peer-instance-pairing.zh.md)

- Date: 2026-11-18
- Kind: feature
- Scope: packages/peer/*, packages/bundle/peer-app, inbound authentication enrollment kinds, `dsh peer` launcher alias

## Decision

Two Harniverse instances pair home-to-home. The home anchors identity: `instance.json` mints one lowercase-UUID id per home (never re-minted), the initiator signs with one P-256 key under `peers/identity.pem`, and the exclusive home lease already guarantees one process per home. Pairing reuses the inbound authentication registry unchanged: `dsh peer invite` issues a one-time `dshi1_` invitation of a new `peer` enrollment kind scoped to a new orthogonal `harniverse.peer` capability; `dsh peer add` enrolls under the deterministic `peer-<instanceId>` name, redeems the invitation (possession acts as approval), exchanges a challenge, and calls `peer/hello`. The grant is created as `api-client` kind with exactly that one capability. Both sides pin the other's instance id: the invitation asserts the target's, and the readback mismatch aborts with `IDENTITY_MISMATCH`.

What was given up: cryptographic binding of the calling grant into the peer record. The Typert Remote boundary does not expose the authenticated principal to service methods, so the record trusts invitation possession plus registry name-uniqueness (the first `peer-<id>` enrollment owns the name; a second key cannot claim it). A challenge-signature hello that binds the calling key waits for principal visibility at the boundary.

## Why home-anchored pairing

The remote-hosts stack already deploys and drives a headless mirror instance per SSH host, but that instance is locked, owned, and ownerless-exit-bound — a mirror, not a peer. Pairing targets the user's own running instances instead: no deployment, no credential synchronization, no mirror semantics. Each side keeps its own model credentials and settings; nothing crosses the boundary except pairing facts. Transports are deliberately not locked to SSH: the invitation endpoint is HTTPS or loopback HTTP, and `--ssh-host` is one dial option that reuses the remote-hosts registry and transport for key-file and agent logins only.

Fail-closed rules: every `peer/*` Remote requires `harniverse.peer`; VM execution worlds compose no `peer-host` row (`$DSH_EXEC_WORLD === 'vm'` disables the entry) and the service additionally refuses hello from VM homes; invitations require an existing owner grant (the bootstrap rule); the invitation token is bootstrap-only and separate from the durable grant credential.

## Surface

- New packages: `dsh-peer-protocol` (vocabulary, codec, identity), `dsh-peer-host` (`ctx.peerHost`, `peer/hello`, `peers.json`, `peer/paired`/`peer/removed` events), `dsh-peer-client` (signing identity, `peer-targets.json`, pairing orchestration), `dsh-peer-app` (`dsh peer invite|add|list|remove|targets|forget`).
- Additive authentication changes: `harniverse.peer` capability; `peer` enrollment kind redeeming to an `api-client` grant; the enrollment route accepts the kind.
- Composition: `peer-host` in the web-app bundle; `peer` builtin profile and launcher alias; CLI dependency.

## Required verification

- Loader-composed real-HTTP pairing end to end (enrollment, redemption, exchange, hello, both stores) in `packages/peer/peer-client/tests/pairing.spec.ts` and the CLI-level round trip in `packages/bundle/peer-app/tests/peer-app.spec.ts`.
- Closed-reason rejections: spent invitation, tampered identity, unreachable origin, VM guard, revoked peer, malformed stores and payloads.
- The invitation-kind path through the provider (`invitation-runtime.spec.ts`) and the capability vocabulary assertion.
- `pnpm run build` regenerates the strict `peer/hello` Remote contract; `packages/peer/peer-host/tests/typert.spec.ts` executes the generated schema.
