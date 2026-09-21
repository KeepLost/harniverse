# Agent Note: Foreign-session archival import runtime

Status: implemented

English | [中文](2026-09-20-session-import-runtime.zh.md)

Scope: `packages/session/session-import`, `packages/core/agent-loop`, `packages/bundle/base`

## Problem

Blueprint W17 required bringing official v1/v2/v3 logs into archival Harniverse v0: header classification, lossy mapping, source-artifact retention, the archival marker, save/search/display, and no execution or live-queue recovery. The first batch shipped the pure contract (classification, `import/record` marker, posture validation, `assertNotResumable`); everything that makes an import actually settle — reading a foreign artifact, mapping its history, persisting it, retaining the source — did not exist, and no live entry point called the guard.

## Decision

- **Shape-driven lossy mapping, not a versioned migration chain** (`src/map.ts`): each foreign event maps by type plus payload compatibility — `user/message`, `assistant/message`, `tool/call`, `tool/result` rebuild messages with fresh local identities and `surfaceOp: 'append'` markers so the native fold and every display surface work unchanged; turn/step markers map when counters are safe integers and `turn/end` only for simple native reasons; everything else (system prompts, request headers, streams, compaction, foreign plugin events) is skipped and counted. The official migration chain (v0→v1→v2→v3 streaming machinery) was deliberately not ported: import is one-way and display-oriented, so per-version fidelity is not worth its weight.
- **Truthful placeholders instead of dropped blocks**: unsupported or malformed content blocks become text placeholders (`[imported image block omitted]`); usage is kept only when numeric; provenance falls back to `unknown` rather than inventing values.
- **Settlement through the persistence seam** (`src/importer.ts`): `ctx.sessionImport.import()` classifies (refusing `current` and `unknown`), maps, appends the marker first, persists via `create`/`append`, and retains the source artifact verbatim beside the mapped session using `locate`. Backends without a per-session artifact location are refused before anything is written — artifact and mapped log settle together or not at all.
- **The guard lives in the agent loop, not in callers** (`agent-loop/src/index.ts`, `resumeWith`): every resume path — direct `ctx.agents.resume`, configured `resumeSessionId` identities, and restore-or-create — applies `assertNotResumable` to the loaded log; an archival session rejects with `ArchivalSessionError`, and the declarative path surfaces it as a contained `agent-loop/config-start-failed`. Because agent-loop is in every composition, `dsh-session-import` became a peer dependency mounted in the base bundle (like `dsh-session-projection` in W11) rather than an optional consumer-side check that a future caller could forget.

## Alternatives considered

- Porting the official format-migration chain and importing at full fidelity: rejected — the blueprint asks for lossy one-way archival display, and per-version streams/request headers have no v0 consumer.
- Guarding at each live entry point (queue, approvals, steering) in consumers: rejected — one choke point inside the loop's single resume path covers every caller, present and future.
- Storing the source artifact in a side directory owned by the importer: rejected — `locate` already names each backend's per-session artifact home; retention beside the mapped log keeps delete/backup semantics in one place.
- Content-hash deduplication of repeated imports: deferred — no product need yet; the Known Limitations record it.

## Consequences

`session-import` is now a contract-plus-runtime package (Service default export over `sessionPersistence`). The base bundle mounts it for the guard; heavier runtime pieces (artifact reading, mapping) execute only when `import()` is called. Imported sessions are saveable, searchable, and displayable through the existing persistence and query surfaces with zero additional integration; they can never resume. SQLite-style backends cannot import until they define an artifact-retention story. Product entry points (CLI/Web) for choosing artifacts and postures remain deferred.
