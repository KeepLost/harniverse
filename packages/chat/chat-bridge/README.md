# `@deepseek-ai/dsh-chat-bridge`

English | [中文](README.zh.md)

The chat bridge core. It consumes `ctx.chatAdapters` ([adapter contract](../chat-adapter/README.md)) and `ctx.harniverseClient` ([`/api` client](../chat-harniverse-client/README.md)), keeps its state in a storage domain, and lets a whitelist of IM members drive Harniverse sessions. The `/api` stays a single-user local API: the bridge is one operator client, and every member distinction exists only inside this package. It is a function plugin (`name`, `inject`, `Config`, `apply`) for a standalone Cordis app, never a plugin of the web composition, and it listens on no port.

Safety rests on five fixed rules. Admission is default-deny. The command table is closed. Approvals go to owners. `danger-full-access` is unreachable because no command changes permissions. Isolation between members is whatever their configured Agent Profile or remote runtime provides.

## Config

Deployment choices are the validated `Config`; the command vocabulary and the rules above are fixed in code. `validateConfig` runs when the plugin mounts and fails on a relative alias path, an unknown alias, a repeated member id or identity, or a `dshRemoteHost` that is not a lowercase v4 UUID.

| Key | Default | Notes |
|---|---|---|
| `owners[]` | `[]` | `platform`, `userId`, optional `agentProfile`, `workspaces` (aliases). Owners hold every grantable command and are set here or by redeeming an owner code. |
| `members[]` | `[]` | `id`, `platform`, optional `userId`, `commands`, `workspaces`, `agentProfile`, `dshRemoteHost`, `answerOwnApprovals` (default `false`). Without `userId` the member joins through a pairing code. |
| `workspaceAliases` | `{}` | Alias to absolute root. Only aliases ever appear in chat. |
| `imRoot` | `~/HarniverseIM` | Working directory for sessions that use no alias: `owner/` for owners, `members/<id>/` for members. |
| `pairing` | 24 h member, 15 min owner | Code lifetimes. |
| `approvalTimeoutMs`, `questionTimeoutMs` | 10 min, 30 min | Then the request is rejected or cancelled. |
| `inbound` | 5 files, 20 MiB each, images up to 4 MiB inline | Larger images and other files upload through `attachment/upload`. |
| `outbound.maxFileBytes` | 20 MiB | Also bounded by the platform's `maxFileBytes`. |
| `streamIntervalMs`, `seenLimit` | 800, 2000 | Edit coalescing; retained inbound ids. |

## Admission and pairing

- A sender acts only when it matches an owner, a member with a static `userId`, or a persisted pairing. An unpaired direct message is ignored; the sender gets a hint to send `/pair <code>` at most once per hour. Unpaired group messages, messages from bots, and unaddressed group messages are dropped silently.
- A pairing code is ten Crockford base32 characters from the system CSPRNG. Only its SHA-256 is stored, redemption deletes it, and it carries its expiry. `dsh chat init` prints an owner code. An owner's `/invite <member>` issues a code bound to a configured member without a static identity; redeeming it binds that platform identity to the member. `/revoke` unbinds it.
- A group chat works only after an owner sends `/pair-group` inside it; then any paired sender can address the bot. A group session is shared, so a sender whose Profile or remote host differs from the session's is refused.
- Every inbound message id is remembered; a redelivery is ignored. Messages of one conversation (`botId:kind:chatId[:threadId]`) run strictly one at a time.

## Commands

Only these commands exist. Any other text that starts with `/`, including path-like text, is answered with an unknown-command notice and never reaches a model. There is no generic `/api` passthrough and no command that changes permissions, context, or exports.

| Who | Commands |
|---|---|
| Anyone paired | `/help`, `/whoami`, `/status`; `/approve`, `/reject`, `/answer` apply to requests the sender may answer |
| Granted per member | `/new`, `/ask`, `/stop`, `/steer`, `/queue`, `/unqueue`, `/sessions`, `/session`, `/ws`, `/model`, `/title`, `/compact`, `/plan`; a plain message is an implicit `/ask` |
| Owners | `/invite`, `/members`, `/revoke`, `/pair-group`, `/unpair-group` |
| Unpaired | `/pair <code>` |

`/stop` cancels the session's running turn and is allowed to the person who started the turn or an owner. `/steer` and `/stop` address the conversation's bound session. `/compact` and `/plan` run as Harniverse commands with a line composed from the fixed name.

## Sessions, workspaces, and isolation

The first prompt in a conversation creates a session. The bridge writes the session record first and then calls `session.create` with a pre-allocated `chat-<uuid>` id, so a crash in between replays with the same id. The working directory is the member's selected alias (`/ws`), else the first alias, else `imRoot`. The Agent Profile is the member's `agentProfile`.

The bridge adds no isolation of its own. Pointing a member's `agentProfile` at an SSH execution Profile puts the session's files, processes, and sandbox on the trusted SSH host. Setting `dshRemoteHost` forwards all of that member's HTTP and event-stream traffic to a remote runtime; the bridge keeps one event stream and cursor set per host.

## Approvals and questions

- An approval card goes to every owner's private chat. A member additionally gets it only when `answerOwnApprovals` is `true`, and the member otherwise sees that the request was forwarded. Buttons answer `allowed-once` or `rejected`; platforms without buttons use `/approve <id>` and `/reject <id>`. The ids are unique to the running process, so an old card cannot answer a new request. Words such as "yes" are never read as approval.
- With no reachable owner the request is rejected at once. After `approvalTimeoutMs` it is rejected and the cards are marked expired. An answer given in the web UI settles the cards. A Host restart expires everything pending.
- A question goes to the chat that started the turn, as buttons for one single-choice question or as text answered with `/answer <id> <answer 1> ; <answer 2>`. Only the asker or an owner can answer; the question is cancelled after `questionTimeoutMs`.

## Rendering and files

A turn started from chat is rendered as a placeholder that is edited in place at the platform's pace, then finished with the complete text, split at the platform's limit. Platforms that cannot edit receive only the final text. Reasoning is not shown and tool activity appears only as a tool name. A rate limit pauses edits for the platform's hint; a failed edit falls back to a new message.

Files the model presents are sent only when the real path lies inside the session's working directory, is a regular file and not a symbolic link, and fits the size caps. Sessions on a remote host do not deliver files. Inbound images up to the inline cap are sent in the prompt; other attachments upload first.

## State

One storage domain (`chat_bridge`) holds pairings, code hashes, bound groups, conversation bindings, sessions, retained message ids, and per-stream resume cursors. Only the running bridge writes it; `dsh chat status` reads it. Prompts awaiting their turn and in-flight replies are not persisted, so a restart loses replies in progress.

## Exports

`apply`, `name`, `inject`, `Config`, `validateConfig`, the pairing helpers (`generateCode`, `hashCode`, `issueCode`, `redeemCode`), `bridgeDomainSpec`, `parseInput`, `COMMAND_TABLE`, and `splitMessageText`. `chat-app` uses the pairing helpers and the state spec to print owner codes.

## Model Experience

### Group chat sender prefix

#### What the model sees

In a bound group chat, each prompt's text is prefixed with `[<platform>·<name>] `, where the name is the sender's display name (or user id) with brackets and line breaks replaced by spaces and cut to 40 characters, or `unknown` when nothing remains. The prefix is part of the logged user message. Direct-chat prompts carry no prefix and no sender identity, and the bridge keeps the message-to-member mapping in its own log.

#### Token effect

A group prompt grows by the prefix, typically under 20 tokens. Direct prompts are unchanged.

#### KV Cache effect

Append-only: the prefix belongs to the newly appended user message and does not alter earlier request tokens.

## Known Limitations and Deferred Work

- Prompts awaiting a turn and replies in progress live in memory; a bridge restart drops them, and a cursor replay does not re-deliver a reply whose prompt was lost.
- Whole-app shutdown disposes the storage domain concurrently with the bridge, so the last second of cursor progress may not be written; it is replayed harmlessly.
- Reactions, voice, locations, message edits, and deletions are ignored. An edited message never re-runs a sent prompt.
- Workspace aliases and `imRoot` are interpreted on whichever host runs the session; the bridge cannot check that a remote path exists.
- A group shares one session; a member whose Profile differs from the creator's must use a private chat.
