# @deepseek-ai/dsh-tool-present

English | [中文](README.zh.md)

The model-facing `present` tool: declares finished files as the Turn's deliverables in the owning Session.

## What it does

Registers one tool, `present(files: [{ path, description? }])`, on `ctx.tools`. The model calls it after writing an output the user asked to receive — including files created through Bash or code execution — and before its final response; naming a path in prose does not replace the call. Files must already exist as regular files on the Session filesystem. A successful call returns `{ turn, files }` and appends one `deliverables/presented` event — `{ turn, callId, files }` — to the calling agent's session log; that event is the durable record UIs and replay fold. The user opens the current source files; contents are neither copied nor preserved.

## Turn and workspace ownership

A call requires its ONE owning agent session (`exec.agent`), an open turn in the `turnBoundary` session projection, and a `cwd` on the session header; each missing piece is a stable rejection. The projection itself is owned by [dsh-agent-loop](../../core/agent-loop): `turnBoundaryProjectionDefinition` registers under `ctx.sessionProjections` when the loop boots, and this package only reads the snapshot (`sessionProjections` is a required injection). Successful deliveries append the declaration event to the calling agent's session — a subagent's declarations land in the subagent's log, not the parent's.

## Configuration

`maxFiles` (default 8) bounds one call's file count. Non-positive or non-integer values fail at load with `present requires a positive integer maxFiles`; a call outside the bound fails with `present accepts 1 to <maxFiles> files`.

## Validation

Beyond the schema's type/required checks, `execute` rejects a blank `path` (`present requires a non-empty file path`) and verifies each file on the live filesystem: an `lstat` non-file entry — a directory or a symlink — fails with `Cannot present <path>: not a regular file`; a file that vanishes between `resolve` and `stat` fails the same way; a missing file fails with the retryable `FsError` ``Cannot present <path>: file not found. Check the path, create the file if needed, and retry.`` (`FS_NOT_FOUND`). A final abort check keeps a cancelled call from declaring anything.

The declaration event fires only for a successful result: a listener on `tools/result` skips errored or blocked calls, so a failed `present` declares nothing and the model simply retries.

## Rendering

The canonical result is `{ turn, files }`; its renderer returns one `Presented <path>` line per file. The call card (`presentCall`) is a generic `Present deliverables` card over the raw input. UIs subscribe to the event stream: the [web client](../../client/ui-deliverables) folds `deliverables/presented` events into a per-Turn presented lane — a declared file shows whether or not the closing prose names it, latest declaration per path wins, and chips open through the chat view's existing opener.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`present` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-present).

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call retains its file list in the arguments. Success returns the `Presented <path>` lines for the declared files. Stable failures are `present requires an agent Session`, `present requires an open turn`, `present accepts 1 to <maxFiles> files`, `present requires a workspace`, `present requires a non-empty file path`, and the per-file `Cannot present <path>` checks above. The full `deliverables/presented` session event is UI and replay state, not a second model message.

#### Token effect

Token growth scales with the declared file list the model submits, and those call arguments remain until compaction. The result lines are one per file and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Regular files only** — directories and symlinks are rejected (`lstat` sees through the symlink itself); presenting a symlink target requires naming the resolved path.
- **No present-specific host routes** — opening a declared file routes through the chat view's existing opener and inherits its loopback/native-opener gating; there is no separate desktop-handoff surface for declarations.
- **Declaration is bounded per call** — at most `maxFiles` files in one call and no spanning/batch API; larger deliveries simply take more calls.
- **The event fires only on success** — a blocked or errored call declares nothing; dedup of repeated declarations is the UI fold's job (latest per path), not the tool's.
