# Agent Note: Session format v0 edge — total classification face

Status: implemented

English | [中文](2026-09-06-session-format-v0-edge.zh.md)

## Problem

The wave-2 A1 decision requires Harniverse to declare its current session vocabulary as format **v0** so any future vocabulary evolution has an anchor, without adopting upstream's v2 vocabulary or its four-package family. The audit found the mechanical edge already fully built: both backends stamp `SESSION_FORMAT_VERSION` (`0`) into stored headers (the JSONL header line's `version` field, the SQLite `sessions.version` column), the coordinator's load path refuses every other version fail-closed as `SessionFormatUnsupportedError` with direction-aware text ("upgrade the harness", never "corrupt"), and the JSONL reader refuses a foreign version before validating today's header shape. What did not exist was a programmable classification face: every consumer that needs to characterize a stored log's version (listing, diagnostics, a future import flow) had to either replay the load path's exception behavior or hand-roll the comparison, with no single home for the semantics.

## Decision

Add one pure total function to the `dsh-session-persistence` seam: `classifySessionFormatVersion(version, currentVersion = SESSION_FORMAT_VERSION)` maps any value to exactly one of `current`, `migration-required`, `unsupported`, or `malformed`. The classification domain is the non-negative safe integers; anything else is `malformed`, a newer version is `unsupported`, and an older generation is `migration-required`. Because `0` is the oldest generation, the default-parameter call can never produce `migration-required` today — the second parameter makes the semantics reachable and pinnable in tests without dead production branches, so the per-file coverage gate needs no ignore comments. The function is the seam's only new public value; backends, the coordinator, and the refusal texts stay exactly as they are, and no migration chain or generation renaming is introduced (the upstream-parallel `migration-required` class is reserved for the first future bump, which will also carry the migration design).

## Alternatives considered

**Fold the classification into `sessionFormatVersionRefusal` or the `SessionFormatUnsupportedError` path.** Rejected: those are load-path refusal mechanics; a listing or import consumer must classify a header without constructing a refusal, and exception-shaped control flow is the wrong face for total questions.

**Omit the `currentVersion` parameter and drop `migration-required` until a second generation exists.** Rejected: the class is the anchor the A1 decision exists to declare; adding it only when first needed would leave nothing to hang the future migration design from, and an unreachable enum member with no producing branch would be a lie in the public type.

## Consequences

Consumers can characterize any stored header version with one total call; the four-value face is documented on the seam README and the persistence subsystems page as the v0-edge declaration. Behavior of every existing path is unchanged by construction (the function is additive; no caller was migrated). Evidence: RED-first spec (`format-classification.spec.ts`, module-not-found before implementation) covering all four classes including the injected-current older-generation semantics; package suite 686/686 green; package `tsc --noEmit` clean; `doc-sync` 29/29 after regenerating the Cordis catalog for the new export.
