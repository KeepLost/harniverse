# Peer pairing packages

English | [中文](README.zh.md)

These packages pair two Harniverse homes so one instance can later delegate and message sessions on the other. Each home anchors one identity — a minted UUID, one P-256 signing key, one session corpus — and the exclusive home lease already guarantees one process per home.

`dsh-peer-protocol` owns the shared vocabulary: the `dsh-peer:` invitation codec, the home-anchored `instance.json`, the closed error set, and the `peer-<instanceId>` grant-name convention. `dsh-peer-host` is the accepting side — the capability-gated pairing and delegation Remotes at `ctx.peerHost` and the authoritative `peers.json`. `dsh-peer-client` is the initiating library — the signing identity, `peer-targets.json`, the enroll-redeem-hello orchestration, and the shared transport dialing. `dsh-tool-peer` exposes delegation to the model as the `peer` tool, `dsh-peer-outbox` is the initiator's settlement ledger — durable watching of accepted-but-running turns with read-only polling and queued delivery into the initiating session — and `dsh-peer-app` (in `packages/bundle/`) is the `dsh peer` one-shot management CLI.

Pairing reuses the inbound authentication registry unchanged: an invitation token approves one enrollment, the grant is created as `api-client` with exactly `harniverse.peer`, and every `peer/*` call fails closed without it. VM execution worlds compose no host row and refuse hello, keeping real-sandbox instances out of the fabric. Design rationale lives in [the instance pairing Agent Note](../../.agents/notes/implemented/feature/2026-11-18-peer-instance-pairing.md).

## Known Limitations and Deferred Work

- Delegation settles synchronously within its budget: no initiator-side outbox queues prompts or polls settlements while a target is unreachable, and cancellation of an in-flight call waits for the sessioned live channel.
- Request proofs carry a timestamp window rather than per-call nonces; per-call replay protection waits for the sessioned channel.
