# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

The contract and runtime for lossy foreign-session import. The contract classifies a stored header's `version` (`classifyForeignSessionFormatVersion`: this build's own `current`, the official `official-v1`/`official-v2`/`official-v3` generations, or refused `unknown`), defines the archival `import/record` marker event an imported session opens with, validates the default import posture (supervision mode, defaulting to supervised and user-selectable), and owns the exclusion guard `assertNotResumable`.

The runtime (`ctx.sessionImport`, composed over a persistence backend) settles one import atomically: it reads the foreign artifact, classifies its header (refusing `current` — native logs restore, not import — and `unknown`), maps the display-bearing vocabulary lossily into native events, appends the archival marker first, persists the mapped session through `sessionPersistence`, and retains the source artifact verbatim beside the mapped session's own artifact (`<sessionId>.source.jsonl`, placed by `sessionPersistence.locate`). Backends without a per-session artifact location (for example SQLite) cannot retain the source and are refused at import time.

Imported sessions are settled archival data inside the v0 format: saveable, searchable, and displayable. The marker names the preserved source artifact. Live machinery never picks them up — the agent loop calls `assertNotResumable` on every resume path (direct `ctx.agents.resume`, configured `resumeSessionId` identities, and restore-or-create), so imported history never executes; a configured resume of an archival session surfaces as a contained `agent-loop/config-start-failed` startup failure.

## Lossy mapping

Only the display-bearing vocabulary maps; everything else is skipped and counted:

- `user/message`, `assistant/message`, `tool/call`, `tool/result` rebuild their messages with fresh local identities (`createUserMessage`/`createAssistantMessage`/`createToolResultMessage`), local `CallId` correlation, and `surfaceOp: 'append'` markers, so the native fold (`deriveMessages`, session query, conversation display) works unchanged.
- Text and reasoning blocks pass through; nested tool-result blocks rebuild recursively; every other block (images, audio, foreign extensions) becomes a truthful text placeholder like `[imported image block omitted]`.
- Assistant provenance is taken from the foreign message's source (top-level fallback, `unknown` when absent); token usage is kept only when numeric; `interrupted: true` survives.
- `turn/start`, `step/start`, `step/end` map when their counters are safe integers; `turn/end` maps only for the simple native reasons (`completed`, `blocked`, `max-tokens`, `interrupted`) — aborted and error turns are skipped rather than guessed.
- System prompts, request headers/context, wire attempts, compaction markers, `todo/write`, `user/file`, and any foreign plugin event map to nothing.

`ImportedSession` reports `mappedEvents` and `skippedEvents` so the caller can surface the loss honestly.

## Config

None — the plugin takes no configuration; the artifact path, optional target id, and optional posture are per-call `import()` arguments.

## Services

| Service | Usage |
|---|---|
| `ctx.sessionPersistence` | Create the mapped session, append its events, and resolve the per-session artifact location for source retention |

Provided: `ctx.sessionImport` — `import(options: ImportForeignSessionOptions): Promise<ImportedSession>`.

## Model Experience

### Imported archival sessions

#### What the model sees

Nothing directly: a session opening with `import/record` is never resumed (`assertNotResumable` in the agent loop), so no imported history reaches a model request. If a future product feature quotes imported history into a live prompt, that feature owns the model-visible wording.

#### Token effect

None — imported sessions never run; mapped events cost storage, not request tokens.

#### KV Cache effect

None — archival sessions never issue requests.

## Known Limitations and Deferred Work

- **Mapping is display-oriented, not faithful** — system prompts, streams, request headers, compaction boundaries, and foreign plugin events are dropped; non-text blocks become placeholders. Fidelity beyond display (for example replaying tool semantics) is out of scope by design.
- **Source retention requires a locatable backend** — the JSONL backend stores `<sessionId>.source.jsonl` beside the session log; backends whose `locate` returns `undefined` (SQLite) cannot import until they define an artifact-retention story.
- **No CLI or Web import entry point yet** — the runtime is a service API (`ctx.sessionImport.import`); product surfaces for choosing artifacts and postures are deferred.
- **No deduplication across imports** — importing the same artifact twice creates two archival sessions; identity by content hash is deferred until a product need exists.
