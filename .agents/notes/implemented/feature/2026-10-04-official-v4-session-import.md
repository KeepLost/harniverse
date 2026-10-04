# Agent Note: Official V4 session import — classification, tool-role results, producer attribution

Status: implemented

English | [中文](2026-10-04-official-v4-session-import.zh.md)

Scope: `packages/session/session-import`

## Problem

Wave-4 absorption row X07: foreign-session import classified only the official v1/v2/v3 generations. An official V4 export — the current official session format — fell to `'unknown'` and was refused, so a corpus exported from the official harness today could not be read back into Harniverse at all.

## Decision

- **`'official-v4'` joins the classification.** `classifyForeignSessionFormatVersion` maps version `4` to a named lossy import class; the invariant companion's classified set and the `ForeignSessionFormat` union grow the same member.
- **Physical framing accepts V4.** Header validation requires the `isSeeded` boolean for version 4 as for v2/v3 (`delegationDepth` stays mandatory for every generation), and the surface-replacement endpoints read `startSeq`/`endSeq` for v3 and v4 alike (v1/v2 use `start`/`end`).
- **First-class tool-role results map.** Official V4 lifts a tool result to a tool-role `tool/result` message: the call id sits on the message itself (`toolCallId`, which must equal the source `callId`) and the content is the direct block list. The mapper rebuilds it through the same native `createToolResultMessage` wrapper as every other result, keeping `isError` and the optional `{name, code}` error.
- **Producer sources attribute verbatim.** A V4 user message names its producer by the source `kind` (`runtime-context`, `plugin:acme`, …); the mapper keeps that string as the plugin name instead of falling back to the importer's own name. Human prompts stay `kind: 'user'`.
- **`forked` closes as interrupted; `developer/message` drops.** Official V4's fork closer and any unknown turn-end reason settle the turn as `interrupted` (the fork point itself is not a native concept); `developer/message` records join system prompts and request context as map-to-nothing, counted in `skippedEvents`.
- **Import-time reading only.** The foreign artifact is read exactly once at import; nothing from it is resumed, queued, or executed. The mapped session is settled archival data under the existing marker, admission policy, and wire refusals — unchanged by this decision.
- **Fixture provenance.** `tests/fixtures/official-v4.jsonl` is copied verbatim from the frozen local upstream `ddefc45fbc` at `snapshots/session/bash-tool-turn/session.v4.jsonl` (upstream `639ed01539`), beside the existing v1/v2/v3 corpora; `officialArtifact()` restores omitted envelope fields without touching payloads.

## Alternatives considered

- **Refusing V4 until a lossless importer exists.** Rejected: the display-bearing vocabulary is the same in kind as v3's; refusing blocks corpus reuse for no preserved fidelity.
- **Mapping V4 through the v3 shapes.** Rejected: V4's tool-role results and producer-kind sources are structurally different; pretending they are v3 blocks would silently drop results and misattribute context.
- **Mapping `developer/message` to a placeholder user message.** Rejected: developer instructions are not conversation content on our side either; a placeholder would inflate the transcript with rows no native fold can ground.
- **Translating the `forked` closer into a native fork event.** Rejected: the native fork vocabulary records a live fork operation, not an imported historical boundary; `interrupted` is the truthful settled posture.

## Consequences

Official V4 exports import with the same lossy honesty as v1–v3: messages and tool traffic survive with fresh local identities, producer context keeps its attribution, and everything non-displayable is counted rather than faked. The v4 fixture pins the mapper against a real official recording, so future official V4 drift surfaces as a fixture failure rather than silent mismapping.

## Verification

- `packages/session/session-import/tests/contract.spec.ts` / `invariant.spec.ts`: version-4 classification and the grown classified set.
- `tests/foreign.spec.ts`: V4 header acceptance (`isSeeded`), `startSeq`/`endSeq` replacements, envelope rejections.
- `tests/map.spec.ts` / `map-boundaries.spec.ts`: tool-role result rebuilds (matching and mismatched `toolCallId`, `isError`, structured errors), producer-kind attribution, `forked` → `interrupted`, `developer/message` skipped, the fixture import end to end.
- `tests/import.spec.ts` / `import-fixture.ts`: the official-v4 corpus settles with mapped/skipped counts and preserved source bytes.
