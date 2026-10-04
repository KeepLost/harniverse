# Agent Note: present batching stance — default cap 4, guidance merged into the description

Status: implemented

English | [中文](2026-10-04-present-batching-stance.zh.md)

Scope: `packages/deliverables/tool-present`

## Problem

Wave-4 absorption row R11: `present` capped one call at `maxFiles` default `8` while its description said nothing about batching. Models answered a multi-file request with one wide call — or, worse, spread one request's files across a trickle of calls — and neither the number nor the ordering carried any stance about what a deliverable handoff should look like.

## Decision

- `maxFiles` defaults to `4` (an explicit configuration still wins; the enforced bound follows `maxFiles`, error text included).
- The `present` description merges the delivery obligation with fixed batching guidance: every file the user asked for must be presented, usually 1–2 files, at most 4 per call, with the most important files first. The guidance names files created through Bash or code execution as presentable too. No Office emphasis.

## Alternatives considered

**Keeping the 8-file default and adding guidance alone.** Rejected: guidance and enforcement would disagree; the first `present accepts 1 to 8 files` failure would teach the model the old number.

**Enforcing an ordering or splitting oversized calls host-side.** Rejected: importance is the model's judgment, and silently rewriting a call hides the model's own batching from the log.

## Consequences

The default stance is small, ordered batches with nothing requested left unpresented. Deployments that legitimately deliver wider sets configure `maxFiles` and the description's "at most 4" reads as the default's stance, while the enforced bound stays configuration-owned.

## Verification

`packages/deliverables/tool-present` suites: the description pins the merged guidance verbatim, the default bound accepts 4 and refuses 5 with `present accepts 1 to 4 files`, and an overridden `maxFiles: 5` admits a five-file call.
