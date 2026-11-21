# @deepseek-ai/dsh-peer-app

English | [中文](README.zh.md)

One-shot peer pairing management app, booted by `dsh peer` (a launcher alias of `--profile peer`). The startup plugin parses the command tree through [dsh-cmdline](../../boot/cmdline/README.md) and provides `ctx.peerStartup`; the runner consumes it, performs one operation against the profile home, and requests process exit.

## Commands

| Command | Side | Behavior |
| --- | --- | --- |
| `peer invite --endpoint <origin> [--name] [--ttl] [--fingerprint]` | accepting | Mints the home identity on first use, issues one `dshi1_` invitation scoped to `harniverse.peer` through the local grant registry, prints the `dsh-peer:` URI and its expiry. |
| `peer add <uri> [--ssh-host <name>] [--timeout <ms>]` | initiating | Decodes the invitation, dials the endpoint directly or through one remote-hosts SSH forward, and runs the complete pairing orchestration from [dsh-peer-client](../../peer/peer-client/README.md). |
| `peer list` | accepting | Lists paired peers from `peers.json`. |
| `peer remove <instance-id>` | accepting | Removes the record and revokes the `peer-<instanceId>` grant when present. |
| `peer targets` | initiating | Lists pairing targets from `peer-targets.json`. |
| `peer forget <instance-id>` | initiating | Drops one target record. |
| `peer run <instance-id> <prompt...> [--cwd] [--profile] [--timeout <ms>] [--async]` | initiating | Starts one delegated session on the paired target and awaits its reply; prints the session line and, once settled, the reply text. `--async` submits with the minimum budget and prints the receipt (session and message id) naming the `dsh peer result` read. |
| `peer send <instance-id> <session-id> <prompt...> [--timeout <ms>] [--async]` | initiating | Delivers the next turn into one delegated session and awaits settlement the same way; `--async` prints the receipt instead. |
| `peer sessions <instance-id>` | initiating | Lists this instance's delegated sessions on the target with live state. |
| `peer cancel <instance-id> <session-id>` | initiating | Cancels the current turn of one delegated session on the target and prints its terminal state; an idle session reports its newest claim's settlement unchanged. |
| `peer result <instance-id> <session-id> <message-id>` | initiating | Reads one delegated turn's settlement without a new prompt — the manual escape hatch behind an async receipt. |
| `peer surface <instance-id> --delegate on\|off --message on\|off --list on\|off` | initiating | Requests one complete surface change on the target: a pure narrowing commits immediately, any widening parks for the target owner's approval and prints the surface still in force. |
| `peer outbox` | initiating | Lists this home's settlement ledger (written by a running instance through `dsh-peer-outbox`); the view never writes. |

Invitations require an existing owner Grant in the target registry (the bootstrap rule); a fresh home pairs only after its owner bootstrap. SSH-dialed adds accept key-file and agent host logins only — password and encrypted-reference logins report `UNSUPPORTED_CREDENTIALS`, because a one-shot process resolves no encrypted credentials.

The runner composes `remote-hosts-ssh` so `--ssh-host` dials the same transport the remote-hosts coordinator uses, reading host records from the profile home's `remote-hosts.json`. Delegation commands resolve the target's stored transport the same way — direct origins dial as-is, `ssh` transports forward to the target's loopback port for the call's lifetime.

## Verification

From the repository root:

```sh
node_modules/.bin/vitest run packages/bundle/peer-app
node_modules/.bin/tsc -p packages/bundle/peer-app/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/bundle/peer-app
```

## Model Experience

None, as this app registers no tools, prompts, or Session events; it exits after one operation.

#### KV Cache effect

None; the app assembles no model input.

## Known Limitations and Deferred Work

- `peer invite` writes invitations through the local registry file; the serving instance observes them through its registry watcher, so a stopped instance must be started before the invitation is redeemed.
- `peer run` and `peer send` are synchronous: a budget that expires with the turn still running prints `state: running` and exits 0; the operator continues the session later by session id. No initiator-side outbox queues prompts while the target is unreachable.
- No invitation listing or revocation commands here; `dsh auth code list` and `dsh auth code revoke` own those operations for every invitation kind.
