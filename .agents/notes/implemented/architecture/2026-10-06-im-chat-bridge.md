# Agent Note: IM chat bridge

Status: implemented

English | [中文](2026-10-06-im-chat-bridge.zh.md)

## Problem

Users want to reach their local Harniverse from a messaging app on a phone. The existing `/api` is deliberately local and single-user: it authenticates one operator and has no notion of other people. Teaching Harniverse about members, per-member permissions, or public ingress would change that trust boundary for every deployment, and the web composition would carry chat concerns it does not otherwise have.

The first platforms are Telegram and Feishu. Both can be reached by outbound connections only, so no public port is needed. A third and fourth platform should cost one adapter, not a redesign.

## Decision

The chat bridge is a separate process, `dsh chat`, that is a client of `/api`. It adds no endpoint and no plugin to the web composition. Multi-user behavior exists only inside the bridge: who may talk to it, which commands each person may run, and where approvals go. The [public-key Grant](2026-08-17-public-key-grant-authentication.md) that authenticates the bridge is an ordinary operator Grant with `harniverse.observe` and `harniverse.operate` and nothing more.

### Package topology

| Package | Role |
| --- | --- |
| `packages/chat/chat-adapter` | Service Definition: the one `ChatAdapter` contract, closed error codes, and the `ctx.chatAdapters` registry with its `chat-adapter/registered` and `chat-adapter/unregistered` events |
| `packages/chat/chat-harniverse-client` | `ctx.harniverseClient`: the only code that calls `/api`, with a closed endpoint table |
| `packages/chat/chat-bridge` | Consumer: admission, pairing, the closed command table, approval routing, streaming replies, durable state |
| `packages/chat/chat-adapter-telegram`, `packages/chat/chat-adapter-feishu` | Platform providers |
| `packages/test-support/chat-adapter-fake` | Scripted platform for bridge tests and the keyless e2e |
| `packages/bundle/chat-app` | The `chat` profile: the shipped patch, the `dsh chat` command, `init`, `status`, and `rotate-key` |

Types, semantics, and the generated Cordis API are on the [chat bridge subsystem page](../../../../docs/subsystems/chat-bridge.md).

### One adapter contract

Every platform implements the same `ChatAdapter`. Differences are declared as `capabilities` and the bridge adapts: no message editing means a final message only, no buttons means text replies, a length limit means splitting, and an edit interval means throttling. An adapter fails with one of eight closed `ChatAdapterError` codes and the bridge maps each to a fixed user-visible behavior. A platform that cannot message a user first returns `undefined` from `directRoute`; an approval with no reachable owner is rejected with a notice to the requester.

### Security posture

- **Default deny.** A sender who is neither a configured owner, a configured member, nor holding a valid pairing code is ignored, with at most one pairing hint per hour. Pairing codes are ten Crockford base32 characters, stored only as SHA-256 hashes, valid once, and bound to the redeeming identity at redemption. `dsh chat init` prints the owner code; an owner issues member codes with `/invite`.
- **Closed command table.** Text starting with `/` that names a command outside the table is refused and never reaches the model. There is no permission, context, export, or generic `/api` command, so the `danger-full-access` preset cannot be reached from chat.
- **Per-member grants.** A member runs only the commands the configuration lists, in only the workspace aliases it lists, and chat text shows aliases, never paths.
- **Approvals go to owners.** A tool approval card is sent to the owners' private chats with the tool name, arguments, and requesting member. A member receives the card and may answer only when `answerOwnApprovals` is set, and an unanswered approval is rejected after `approvalTimeoutMs`. Over chat, outcomes are `allowed-once` and `rejected` only.
- **The model-visible record names the speaker.** A group prompt is prefixed with the platform and sender name, so the session log records who spoke.
- **Files leave only from the workspace.** A presented file is sent back only when its real path is inside the session workspace.
- **Idempotent intake.** Every mutating call carries an `Idempotency-Key` derived from the platform message id, and the bridge keeps processed message ids, so a redelivered message starts one turn.

### Isolation is the owner's choice

The bridge adds no isolation layer. A member whose configuration names an `agentProfile` that runs on an SSH execution Profile, or a `dshRemoteHost` that forwards requests to a remote runtime, works on that trusted machine. A member with neither works in a bridge-owned directory under the owner's `imRoot`.

### Platform transports

Telegram uses `fetch` against the Bot API with long polling and no SDK. Feishu uses the `ws` package for the long connection and a hand-written codec for its `pbbp2.Frame` protobuf; the codec is byte-identical to the official SDK's encoding on the recorded frames, and the SDK is not a dependency. Source ported from dsh-im keeps its MIT header and is listed in [`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) under [generated notices](../process/2026-07-30-generated-third-party-notices.md).

### The `chat` profile

`dsh chat` is a `dsh auth`-style alias: `PROFILE_TEMPLATES.chat` is `['@deepseek-ai/dsh-chat-app']`, and the bundle declares `homeOwnership: "shared"`, so the bridge and its maintenance commands run while Web holds the home lease ([profile home ownership](2026-09-27-profile-home-ownership.md)).

`dsh chat init` creates a P-256 key, registers the `chat-bridge` Grant, stores both as credentials under `$DSH_HOME/chat-bridge/`, writes a configuration template to `$DSH_HOME/profiles/chat/patch.yml`, and prints a 15-minute owner code. `rotate-key` replaces the key and Grant and revokes the old Grant. `status` reports the key, Grant, Harniverse reachability, and stored counts.

The bridge rows mount only for `dsh chat` and `dsh chat run`. The Loader evaluates a row's `disabled` once, when the row is created, before a sibling plugin can publish a service, and a patch replaces a row's whole `config`, so neither a service value nor a config flag can gate the rows. The shipped patch instead reads the launcher's `cmdlineArgs` snapshot in the `disabled` expression, and `src/startup.ts` holds the matching default-to-run rule.

### Testing

The bridge core runs against `chat-adapter-fake` and a scripted client with coverage of every source file. Each provider is tested against a scripted platform server, with the Feishu socket exercised through a real `ws` loopback. Real-Loader composition tests mount the shipped patch for the bundle, the bridge, the client, and each provider. A keyless e2e in `apps/web/tests` boots the real web composition with Grant authentication and a replayed model, runs `dsh chat init` and `dsh chat` through the Loader with the fake platform, and drives: one-time pairing with unknown senders ignored, unknown commands refused, a streamed reply recorded as a golden transcript, duplicate delivery, Grant revocation, `/stop`, a presented file sent back, an approval that only the owner can answer, approval timeout, and a question answered from chat.

## Alternatives considered

**A multi-user gateway inside Harniverse.** Per-member Grant endpoint constraints and a `chat/inbound` endpoint would make Harniverse a multi-tenant server. The owner model keeps `/api` single-user and puts the whole policy in a client that can be replaced without touching the server.

**A plugin in the web composition.** It would share the process and skip the Grant, at the price of putting platform credentials, long-lived outbound connections, and chat policy in the process that serves the browser, and of making chat impossible to run without the web UI.

**Running dsh-im beside Harniverse.** dsh-im has its own session model and release cadence. Porting its proven platform code into this repository's plugin architecture keeps one credential store, one Grant, one state domain, and one test suite.

**Fixed guest, member, trusted, and owner tiers, secret masking, an audit log, and rate quotas.** Isolation already comes from choosing the Profile or remote host per member, and masking cannot make a shared filesystem safe. A tier table would promise more than it enforces.

**Webhooks and a relay.** A public endpoint would be a new attack surface. Both platforms deliver over connections the bridge opens itself.

**The Feishu SDK and `protobufjs`.** They would add runtime dependencies for one frame type. A small codec, verified byte-for-byte against the SDK on recorded frames, costs less than carrying either.

**Gating the bridge rows with a service value or a config flag.** Neither survives the Loader's one-time `disabled` evaluation and whole-`config` patch replacement, so the rows read the argument snapshot instead.

## Consequences

The bridge ships without any change to `/api` or the web composition, and a new platform costs one package implementing `ChatAdapter`. The chat profile coexists with Web, and a lost or rotated Grant is recoverable with two commands.

Telegram and Feishu are verified only against scripted servers. No run has used a real bot token or Feishu app, so first use on a real platform may surface differences in group privacy settings, edit windows, or event payloads that fixtures do not model.

The Feishu codec tracks a protocol the vendor can change, and its byte-identity check covers only recorded frames. The enabled-rows rule is written twice, once in YAML and once in the command grammar, and the e2e `dsh chat` runs pin both.

The bridge holds its state in one JSON storage domain with no cross-process lock, which is safe because the profile allows one running bridge; `status` only reads it, and nothing guards that read against a concurrent run. On whole-app shutdown the storage domain can close before the bridge's last cursor write, which only widens the next replay.

Identities on different platforms are separate; one person on Telegram and Feishu needs two pairings.
