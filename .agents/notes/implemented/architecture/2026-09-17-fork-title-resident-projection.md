# Agent Note: Fork title increments read the resident title projection, not the projected list store

Status: implemented

English | [中文](2026-09-17-fork-title-resident-projection.zh.md)

- Date: 2026-09-17
- Scope: `@deepseek-ai/dsh-client-runtime` (session fork title policy)
- PR: pending (this note ships with the fix)

## Problem

A branch gesture taken within roughly a second after a reconnect produced a child whose title never gained its ` (1)` increment. The e2e `chat-long-interactions` scenario hit it under CI load: the recorded continuation script for the branched child was never consumed, and the breadcrumb poll timed out showing the unsuffixed title.

`SessionService.fork({ increaseTitle: true })` read its source title from the projected session-list store (`list.getSnapshot().byId[id].title`). That store is a flush away from the title's actual home: titles live in the manager's resident per-session projection store, and the list store only sees them after the projection's `markDirty` flush cascades into `projectList()`. A reconnect rebuilds the list baseline with no titles and re-lands each title asynchronously, so a fork racing that re-landing read `undefined` and treated it as "no durable source title" — silently skipping the rename while still opening the child. The UI showed a correct title throughout because the breadcrumb reads the session's own projection face, which masked the lag.

## Decision

`fork` now reads the source title through `SessionManager.titleOf(sessionId)` — a synchronous read of the resident `'title'` projection, the exact source `buildListSnapshot` itself reads when building list rows. The snapshot builder reuses the same accessor so the two reads cannot drift. The projected list store keeps its role for rendering; it is no longer an input to the fork title policy.

## Alternatives considered

- **Retry or await the list flush before reading the title**: rejected — it would add a wait to a user gesture to paper over reading the wrong source; the authoritative value is already synchronously readable.
- **Move the increment host-side (fork RPC gains rename semantics)**: a wire-contract change out of proportion to the defect; the client already owns the title policy (`increaseTitle` is a client concern).
- **Treat a missing title as a fork failure**: would break branching for sessions that legitimately have no title yet (blank cwd-only sessions).

## Consequences

- A branch taken while the list store lags a title re-land now still produces the incremented child title; the "silently unsuffixed child" state is gone.
- `titleOf` is the single sanctioned synchronous title read for policy code; list rows and policy now share one source of truth.
- The pre-existing no-title behavior is preserved: no durable title means no rename, by design.

## Verification

- New regression test in `sessions-service.client.spec.ts`: a fork issued in the same synchronous tick as the `session/projection` title frame — before any flush can land it in the list store — still sends the `session.rename` increment. The test fails against the previous store-backed read.
- The pre-existing "does not rename without the title policy or a durable source title" arm still passes: with no title projection at all, `titleOf` is `undefined` and no rename fires.
- `pnpm run test:gui` 336 files green; `chat-long-interactions` e2e green under `DSH_SNAPSHOT=replay`.
