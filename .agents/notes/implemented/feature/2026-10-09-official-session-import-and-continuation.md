# Agent Note: Import official DeepSeek Harness sessions and continue them

Status: implemented

English | [中文](2026-10-09-official-session-import-and-continuation.zh.md)

## Problem

Harniverse could already map an official session log into a read-only archive ([session-import runtime](2026-09-20-session-import-runtime.md), [official v4 import](2026-10-04-official-v4-session-import.md)), but no user could reach it. The only entry was the raw `POST /api/session/import` route, which nothing in the web client called. Even through that route the import failed on the logs official builds actually write: they default to multi-frame Zstandard `session.vN.jsonl.zstd`, and the importer decoded uploads as plain UTF-8. Nothing scanned `$DSH_HOME/sessions` for official logs, importing the same file twice produced two archives, the official title was lost, and the client never learned that an archive existed until it reconnected.

An archive also could not be used for anything but reading. A user moving from the official build wants to keep talking with the history they brought over, and the archive guard forbids an imported session from ever running.

## Decision

The feature has three surfaces over the existing seam, each owned by its plugin.

**The importer accepts real official logs and owns archive identity** (`dsh-session-import`). It decodes Zstandard artifacts frame by frame through `decodeZstdArtifact`, newly exported from the JSONL backend that owns the container, drops an EOF-torn final frame, and keeps the exact source bytes as `.source.jsonl.zstd`. An archive's id is `session-imported-<sha256(foreign id)[:16]>-<sha256(text)[:16]>`: the same content always maps to the same id, so a second import throws `ImportConflictError` (409 on the raw route) instead of duplicating, whatever encoding or workspace it arrives through; a grown source gets a new id with the same lineage prefix, which is how a scan tells "updated" from "imported". The existence check reads `persistence.list()`, because the JSONL directory is keyed by cwd and the same id in two project directories would make listing ambiguous. `describe(artifact)` reports what an artifact would import as without persisting. The latest official title maps to one native `session/title` with the `user` source, since it is provenance rather than a derivation from the mapped messages. The marker gains optional `source.sessionId` and `source.cwd`. Each settled import emits `session/imported`; the API proxy turns it into `host/session-added`, because an archive is persisted detached and never fires `session/created`. A `sessionImport` projection unit reports the marker's provenance to clients.

**A host Remote discovers and imports on the serving machine** (`dsh-host-official-session-import`, namespace `officialSessionImport`, all methods `harniverse.operate`). `scan` walks the configured roots (the web-app bundle passes `dshHomePath('sessions')`, the directory official builds share), keeps the newest `session.vN.jsonl[.zstd]` of each session directory, describes each through the importer with a size-and-mtime cache, and marks each candidate `new`, `imported`, or `updated` from the persisted ids. `importSources` resolves opaque ids back under their root and refuses anything else; `importUpload` takes a base64 log bounded before and after decoding. The target is a registered workspace or `source-cwd`, the workspace at the official session's own directory, registered on demand. Outcomes are per item and never throw. Because the row sits in the web-app bundle, the remote-server composition carries it, and the gateway's existing Remote forwarding sends calls to the targeted machine, which scans and imports into its own DSH home.

**Continuing creates a new session; the archive stays an archive** (`session.continueArchive` in the API proxy, seed from `dsh-session-import`). `continuationSeedOf` drops the marker and the importer's notice, opens with a model-visible note naming the origin and the loss, renumbers events while rewriting surface references, and closes unanswered tool requests with the core interrupted-tool result so the next provider request is well formed. The proxy composes the continuation like `session.create` (agent profile, model profile, preset refusals), places it in the chosen workspace, else the archive's workspace, else the archive's cwd, and records no lineage so the archive can still be deleted. An `import/record` marker also ends a session's blank phase, so an archive without turns can never be reused as a workspace's blank session.

**The browser side** (`dsh-client-ui-session-import`) adds the "会话导入" settings section — scan per machine target, multi-select with status, target select, upload, per-item results with an Open action that waits for the archive's row — and an archive dock in `conversation.input.dock` that reads the `sessionImport` projection, raises a composer block through `ctx.conversation.blocks`, and offers an agent-preset select plus "继续对话", which calls the new `ISessions.continueArchive` and opens the continuation.

## Alternatives considered

**Lift the archive guard and let an archive resume.** Rejected: the archive is the retained record of what the official build did, and its mapped log lacks system prompts and request headers a resumed Agent expects. A continuation keeps the record intact and puts the loss in front of the model explicitly.

**Seed the continuation with `parentSession` pointing at the archive.** Rejected: the proxy refuses to delete a session with non-subagent descendants, so the archive could never be removed while a continuation exists, and lineage drives nothing else for ordinary sessions.

**Extend `session.fork` to accept archives.** Rejected: fork inherits the source's composition and cuts at a turn boundary, while a continuation chooses a new composition and takes the whole history; one RPC with two meanings would need option combinations only valid for one source kind.

**Raw upload route for the browser.** Rejected: exact routes are served by the page Host and never forwarded, so uploads to a remote host would land on the wrong machine; the Remote carries base64 at the cost of a third more bytes.

**Dedup through an import index.** Rejected: a content-derived id needs no second durable state to keep consistent with deletions, and `persistence.list()` already answers existence.

**Composer takeover chain for the archive notice.** Rejected: chain selectors read only owner props, which carry no projection values; the dock reads the projection through its own hook, and the existing block registry disables the textarea.

## Consequences

A user opens Settings → 会话导入, sees the official sessions on the targeted machine, imports them into their original directories or a chosen workspace, opens an archive, and continues it with a chosen preset. Re-importing an unchanged log reports "已导入"; an updated one imports as a second archive.

The durable additions are additive: `import/record` gains two optional source fields (its payload type name, and so the session contract digest, is unchanged), imported archives carry a `session/title` event, and `sessionListMetadata`'s fold changed, so its `stateVersion` is 2 and stale cached rows are discarded. Archives imported before this change keep their random ids and are not recognized as imported by a scan.

The model sees imported history only in a continuation, opened by the origin note pinned in the session-import README; the continuation's first request carries the whole mapped history as input.

Verification: session-import (identity, Zstandard, description, title, projection, event, continuation seed), the JSONL whole-artifact reader, the Remote (discovery, faults, service, generated contract, a real Loader composition importing into a registered workspace), the proxy's `continueArchive` and import announcement, the client runtime's `continueArchive`, and the client package are at 100% line and branch coverage. `apps/web/tests/session-import.e2e.ts` drives the shipped web composition keylessly: it scans an official v4 Zstandard log in the sessions root, imports it into the workspace at its cwd, opens the archive with its dock and inert composer, and continues it, asserting the continuation's seed in the host log; the settings-nav goldens of four other scenarios gained the new section.
