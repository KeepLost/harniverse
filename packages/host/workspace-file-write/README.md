# `@deepseek-ai/dsh-workspace-file-write`

English | [中文](README.zh.md)

`ctx.workspaceFileWrite` is the Host Remote behind the workbench preview's editing occupant: workspace-scoped, `harniverse.operate`-gated file open/stat/save for user-initiated edits. It composes independently of the read-only `workspace.files.*` inspection API — without this package (and without the browser-side `dsh-client-ui-workspace-editor` row) the workbench preview stays read-only.

## Surface

All three methods address a registered Workspace by id (never a Session) and are exposed through the Typert gateway as `workspaceFileWrite/open`, `/stat`, and `/save` over the shared `/api` RPC channel.

- **`open(workspaceId, path)`** reads one complete regular file inside the registered Workspace root: ≤ 1 MiB, decodable through the shared codec's ordered candidate walk, single line-ending style. Content returns LF-normalized with the `FsVersion` base and the `{encoding, encodingSource, bom, eol}` decision. Refusals are typed: mixed EOL (`mixed-eol`), undecodable/binary (`not-text`), oversize (`too-large`), symlink on the path (`symlink`), `.git` path segment (`git-dir`), escape (`path-invalid`), missing or non-regular (`not-found`, `not-regular`).
- **`stat(workspaceId, path)`** returns the file's authoritative `FsVersion` or `absent`. The watch feed's change-frame version is a different format and must never be compared with this one.
- **`save(workspaceId, path, { content, baseVersion, saveId })`** writes through `ctx.fs.writeText` under `replaceIfVersion`, so the write inherits the local backend's per-target lock (shared with the Agent tools), private staging, atomic publication, and mode/DACL preservation. A changed file refuses with `stale-version` and the current version; characters the file's original encoding cannot represent refuse with `unmappable` and the line/column position — never a `?` byte. The encoding, byte order mark, and line-ending style are re-derived from the disk file inside the CAS window (never trusted from the wire) and reproduced on write-back.

`saveId` is the caller-minted idempotency identity the Typert path otherwise lacks: a retried request whose `saveId` already committed replays the recorded outcome instead of writing again (bounded FIFO of 128 outcomes).

## Path rules

The hard rules are enforced Host-side and are deliberately not configurable: registered Workspace root must still be its canonical directory, request paths are relative and contained, no path segment may be `.git`, the target's canonical form must equal its lexical spelling (any symlink refuses), and the file must be a regular file within the 1 MiB editing bound. The write additionally runs under an explicit `workspace-write` sandbox policy rooted at the canonical Workspace directory. User saves never pass the Agent sandbox presets or approval paths — the answering principal already holds `harniverse.operate`, the same capability `terminal.write` requires — and they record no Agent observation, so an Agent's next guarded write against the same file reports `FS_STALE_VERSION` and must re-read.

## Events and Agent notice

Each committed save emits `workspace-file/saved { workspaceId, path, version, bytes }` at the write's commit point. The same package listens for that event and injects one non-waking, path-only notice into every live session whose canonical cwd equals the Workspace path (bounded to 32 sessions per save, at most one notice per session and path per 10 seconds). Cold sessions receive nothing; a resumed session sees the notice with its next claim.

## Model Experience

### Save notice injected into workspace sessions

#### What the model sees

One user message in the session inbox (non-waking: claimed at the next step boundary, or with the next prompt of an idle session), carrying only the edited path — never content or a diff.

##### Verbatim text for this field

```markdown
The user saved an edit to "src/main.ts" in the workbench editor. Your earlier view of that file may be stale; read it again before editing it or relying on its earlier contents.
```

#### Token effect

Conditional: roughly 40 tokens per noticed save, coalesced per session and path within the 10-second spacing window.

#### KV Cache effect

Append-only while idle (notices accumulate until the next claim); a claimed notice joins the next request's user-message prefix. Saves themselves invalidate nothing — the model's earlier file reads simply become stale facts the notice names.

## Known Limitations and Deferred Work

- **Process-local lock boundary** — the CAS window is guarded by the local backend's in-process per-target lock; writes from other processes (`bash`, external editors, `git checkout`) can still interleave in the tiny probe→rename window, the same residual risk the Agent tools carry.
- **Notice plugin is not separately composable** — the save-notice listener ships inside this package; a composition that wants silent saves cannot remove it without removing the Remote (the investigation's D6 preferred a separate `workspace-edit-notice` plugin).
- **Remote-version mismatch** — a remote Host whose composition predates this package answers `service-unavailable`; the client occupant degrades to its read-only fallback rather than assuming endpoint parity.
- **SSH execution worlds** — the workbench edits the Host-local registered directory; a session whose execution world is `fs-ssh` writes a different filesystem under the same displayed path.
