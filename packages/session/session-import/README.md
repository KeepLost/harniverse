# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

The contract and runtime for lossy foreign-session import. The contract classifies a stored header's `version` (`classifyForeignSessionFormatVersion`: this build's own `current`, the official `official-v1`/`official-v2`/`official-v3`/`official-v4` generations, or refused `unknown`), defines the archival `import/record` marker event an imported session opens with, validates the default import posture (supervision mode, defaulting to supervised and user-selectable), owns the exclusion guard `assertNotResumable`, and derives the seed a live continuation of an archive starts from (`continuationSeedOf`).

The runtime (`ctx.sessionImport`, composed over a persistence backend) settles one import atomically: it reads the foreign artifact (plain JSONL, or a Zstandard-framed log as official builds write it, decoded frame by frame with an EOF-torn final frame dropped), classifies its physical v1/v2/v3/v4 framing (including v1 packed rows), refuses `current` and `unknown`, maps the display-bearing vocabulary lossily into native events, appends the archival marker and synthetic foreign-origin message, persists the mapped session through `sessionPersistence`, and retains the exact source bytes beside the mapped session's own artifact (`<sessionId>.source.jsonl`, or `.source.jsonl.zstd` for a compressed source, placed by `sessionPersistence.locate`). The authorized product entry supplies the destination workspace; foreign `cwd` is provenance only, recorded on the marker. Backends without a per-session artifact location (for example SQLite) cannot retain the source and are refused at import time.

An archive's identity derives from its content: `session-imported-<lineage>-<content>`, where the lineage half hashes the foreign session id and the content half hashes the decoded log text. Importing the same text again, through any encoding or into any workspace, throws `ImportConflictError` naming the existing archive; a source that grew since gets a new id under the same lineage prefix. `describe(artifact)` reads what an artifact would import as — provenance, latest title, first human prompt, turn count, update time, the archive id, and the lineage prefix — without persisting anything. Every settled import emits `session/imported` with the archive's header, because the archive is persisted without attaching and never reaches `session/created`.

Imported sessions are settled archival data inside the v0 format: saveable, searchable, and displayable. The marker names the preserved source artifact. Live machinery never picks them up — the import plugin registers an admission policy covering every Agent create/resume/fork/restore path, and the API archive projection rejects queue, approval, prompt, steering, and fork mutations. Cold history reads do not publish an Agent or start a turn. The plugin's `sessionImport` projection unit reports the marker's provenance (`format`, optional `sourceSessionId` and `sourceCwd`) on an archive and `null` elsewhere; clients read its type through `./client`.

## Lossy mapping

Only the display-bearing vocabulary maps; everything else is skipped and counted:

- `user/message`, `assistant/message`, `tool/call`, `tool/result` rebuild their messages with fresh local identities (`createUserMessage`/`createAssistantMessage`/`createToolResultMessage`), local `CallId` correlation, and `surfaceOp: 'append'` markers, so the native fold (`deriveMessages`, session query, conversation display) works unchanged. Official v4's first-class tool-role results rebuild through the same native wrapper, and official v4 producer sources attribute their context to a plugin named by the source `kind` (for example `runtime-context`).
- Text and reasoning blocks pass through; nested tool-result blocks rebuild recursively; every other block (images, audio, foreign extensions) becomes a truthful text placeholder like `[imported image block omitted]`.
- Assistant provenance is taken from the foreign message's source (top-level fallback, `unknown` when absent); token usage is kept only when numeric; `interrupted: true` survives.
- `turn/start`, `step/start`, `step/end` map when their counters are safe integers; `turn/end` maps completed, blocked, max-token, aborted-user, provider-error, and interrupted reasons, while official v4 `forked` closers and unknown reasons close as interrupted. Incomplete boundaries are normalized closed.
- The latest usable `session/title` maps to one native title after the history, one-lined and bounded to 120 graphemes, with the `user` source that cites no message seqs; superseded and unusable titles count as skipped.
- System prompts, request headers/context, wire attempts, compaction markers, `todo/write`, `user/file`, official v4 `developer/message` records, and any foreign plugin event map to nothing.

`ImportedSession` reports `mappedEvents` and `skippedEvents` so the caller can surface the loss honestly, plus the foreign session id and the imported title.

## Continuation seed

`continuationSeedOf(events)` turns an archive's log into the seed of a new live session: it drops the `import/record` marker and the importer's own archive notice, opens with one plugin-sourced origin note, renumbers every event densely while rewriting surface references, and closes each unanswered assistant tool request inside its step with the core interrupted-tool error result. The API proxy's `session.continueArchive` consumes it; this package owns the seed and the note.

## Config

None — the plugin takes no configuration; the artifact path, optional target id, and optional posture are per-call `import()` arguments.

## Services

| Service | Usage |
|---|---|
| `ctx.sessionPersistence` | List existing ids, create the mapped session, append its events, and resolve the per-session artifact location for source retention |
| `ctx.sessionProjections` (optional) | Register the `sessionImport` provenance unit |

Provided: `ctx.sessionImport` — `import(options: ImportForeignSessionOptions): Promise<ImportedSession>` and `describe(artifact: Uint8Array): ForeignArtifactSummary`. Event: `session/imported(header)`.

## Model Experience

### Imported archival sessions

#### What the model sees

Nothing directly: a session opening with `import/record` is never resumed (`assertNotResumable` through the Agent admission policy), so the archive itself reaches no model request.

#### Token effect

None — imported sessions never run; mapped events cost storage, not request tokens.

#### KV Cache effect

None — archival sessions never issue requests.

### Continuation seed

#### What the model sees

A continuation's first request carries the seeded history as ordinary messages: one plugin-sourced user message (`@deepseek-ai/dsh-session-import`) first, then the mapped user, assistant, and tool-result messages, with any unanswered tool request answered by the core interrupted-tool error text. The note reads, with the source directory clause present only when the archive recorded one:

##### Continuation origin note (first seeded user message)

```markdown
The conversation history below was imported from an official DeepSeek Harness session that ran in "<source cwd>". It was mapped lossily: system prompts, compaction summaries, and non-text content are omitted, and its tool calls ran in that environment, so files and state they describe may differ now.
```

#### Token effect

The whole mapped history plus the short note becomes input of every continuation request until compaction applies; placeholders replace dropped non-text blocks, so images cost no tokens.

#### KV Cache effect

The seed is a fixed prefix of the continuation's log, so after the first request warms it, later requests of that continuation reuse it; two continuations of one archive repeat the same prefix only when their system prompt and tools match.

## Known Limitations and Deferred Work

- **Mapping is display-oriented, not faithful** — system prompts, streams, request headers, compaction boundaries, and foreign plugin events are dropped; non-text blocks become placeholders. Fidelity beyond display (for example replaying tool semantics) is out of scope by design, and a continuation inherits the same loss.
- **Source retention requires a locatable backend** — the JSONL backend stores the source artifact beside the session log; backends whose `locate` returns `undefined` (SQLite) cannot import until they define an artifact-retention story.
- **A grown source makes a second archive** — re-importing an updated official session creates a new archive under the same lineage instead of appending to the old one; the old archive stays until the user deletes it.
- **The whole log is read at once** — import and description decode the full artifact in memory; callers bound its size.
