# @deepseek-ai/dsh-peer-host

English | [中文](README.zh.md)

The accepting side of instance pairing: the capability-gated `peer/hello` Remote and the paired-peer store. `PeerHost` is the default-exported `TypertRemoteService` at `ctx.peerHost`, wire namespace `peer`, composed in the web-app bundle. Required injections: none — the store and identity files under the resolved home are the only state.

## Remote surface

| Method | Wire arguments | Capability | Result |
| --- | --- | --- | --- |
| `hello(identity)` | `{ identity: PeerHelloInput }` | `harniverse.peer` | `PeerHello` |

`hello` validates the self-asserted initiator identity, reads this home's `instance.json` (never minting — a home that never invited answers `CORRUPT_INSTANCE`), commits or refreshes the peer record, and answers with this instance's identity plus the approved surface. The first record for an id emits `peer/paired`; a revoked record rejects `HELLO_REJECTED`. Every call refuses `PEER_UNAVAILABLE_VM` inside a VM execution world, and the web-app composition disables the row entirely under `$DSH_EXEC_WORLD === 'vm'`, so real-sandbox instances never pair.

## Store

`peers.json` under the home is the authority: strict-shape validation, insertion-order records, atomic owner-only writes through `writePeerStore`. The `peer/paired` and `peer/removed` events are live-process observations; out-of-band CLI mutations do not emit them. `removePeer(instanceId)` deletes one record and emits `peer/removed`; the packaged CLI revokes the matching grant separately.

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

None, as this plugin registers no tools, prompts, or Session events; the paired surface reaches models through the future delegation and messaging packages.

#### KV Cache effect

None; the plugin assembles no model input.

## Known Limitations and Deferred Work

- The Remote cannot see the calling principal, so the peer record trusts the invitation-possession chain plus registry name-uniqueness instead of binding the grant id into the record; a future challenge-signature hello binds the calling key cryptographically.
- Surface widening and narrowing are record edits, not new Grant capabilities; no approval flow exists for surface changes yet.
