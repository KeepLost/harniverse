# Agent Note: Fork title policy waits out a briefly trailing title projection

Status: implemented

English | [中文](2026-09-18-fork-title-settle-wait.zh.md)

- Date: 2026-09-18
- Scope: `@deepseek-ai/dsh-client-runtime` (fork title policy)
- PR: pending (this note ships with the fix)

## Problem

The `chat-long-interactions` e2e failed on the release line under CI load — twice, including a run predating today's work: after a branch gesture the child's breadcrumb never gained its ` (1)` increment within the 30-second window. The 2026-09-17 fix moved the policy's source read to the resident `'title' projection, but a residual window remained: when the title projection frame itself had not landed yet (host title computation trailing a settle under load), `titleOf` returned `undefined` and the policy silently skipped the rename by design.

## Decision

`SessionRuntime.fork` with `increaseTitle` now reads the source title through a bounded settle wait: an immediate `titleOf` hit resolves synchronously as before; a miss polls every 50ms for up to 5 seconds for the authoritative projection frame to land, and only past that bound does the established no-title-no-rename rule hold. The wait exists solely on the `increaseTitle` path — forks without the title policy never wait.

## Consequences

- A branch taken in the trailing window of its title projection now still produces the incremented child title; the CI-load flake's mechanism is closed.
- Blank sessions (no durable title by design) branch exactly as before — after the bounded wait rather than instantly, which is invisible except in the no-title fork path's latency.
- The gesture can now take up to 5 seconds only in the pathological case where a title was expected but never lands.

## Alternatives considered

- **Retry or await the list flush** (the previously rejected paper-over): different object — that fixed reading the wrong source; this waits for the authoritative source's own arrival, which no synchronous read can conjure.
- **Host-side increment in the fork RPC**: rejected before for wire-contract disproportion; unchanged.
- **Failing the fork on a missing title**: still breaks legitimate no-title sessions.
