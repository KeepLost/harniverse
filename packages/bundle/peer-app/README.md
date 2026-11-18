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

Invitations require an existing owner Grant in the target registry (the bootstrap rule); a fresh home pairs only after its owner bootstrap. SSH-dialed adds accept key-file and agent host logins only — password and encrypted-reference logins report `UNSUPPORTED_CREDENTIALS`, because a one-shot process resolves no encrypted credentials.

The runner composes `remote-hosts-ssh` so `--ssh-host` dials the same transport the remote-hosts coordinator uses, reading host records from the profile home's `remote-hosts.json`.

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
- No invitation listing or revocation commands here; `dsh auth code list` and `dsh auth code revoke` own those operations for every invitation kind.
