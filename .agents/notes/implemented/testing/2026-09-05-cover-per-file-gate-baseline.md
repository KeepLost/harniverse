# Agent Note: Close the per-file coverage gate baseline

Status: implemented

English | [中文](2026-09-05-cover-per-file-gate-baseline.zh.md)

## Problem

The `node 24 / coverage` lane had been failing on `master` with 1,501 uncovered locations across 74 source files — accumulated baseline debt that predated the branch. The regression stayed invisible because `all-checks-passed` had lost its `node-24-coverage` needs edge, so the aggregate kept reporting success while a blocking gate was red.

## Decision

The baseline is closed with real suites, not configuration: every previously failing file now meets the per-file 100% threshold through behavioral tests (new focused spec files plus extensions to existing ones, roughly 2,900 added test assertions across 90 changed files). Where an uncovered arm was provably unreachable defensive code, the dead arm was removed instead of annotated — sites in `capability/capabilities`, `core/model-policy-fallback`, `session/session-persistence-jsonl`, `spill/spill-local`, `auth/authentication-local`, `subagent/tool-subagent`, `mcp/mcp-user-config`, `web/web-fetch-http`, `fs/tool-str-replace-editor`, `skill/skill-filesystem`, `context/session-reference`, `settings/settings`, and three client components — each justified by an owning invariant (Settings schema validation, vendored-cordis disposer semantics, non-optional regex groups, React disabled-button semantics, or render gating). No behavior changed on reachable paths, so no plugin ledger entry in `PLUGINS.md` applies.

The aggregate's documented contract is also restored: `node-24-coverage` is listed in `all-checks-passed` needs again, so a future coverage failure fails the required check instead of hiding behind the aggregate.

## Alternatives considered

**`/* v8 ignore */` comments or threshold exclusions.** Rejected: the gate's value is per-file enforcement, and an ignore without an unreachable-by-construction reason masks drift the repo policy explicitly forbids.

**Lowering per-file thresholds.** Rejected: a well-covered big file would subsidize a bare one — exactly the failure mode the per-file design exists to prevent.

**Leaving the gate unenforced and the debt unpaid.** Rejected: red required lanes on `master` are the CI technical debt this branch set out to remove.

## Consequences

The coverage lane enforces again and passes; Windows native complete, which re-runs the same gate, passes with it. Dead defensive arms are gone rather than ignored, so future coverage reports signal real gaps only. New uncovered code must arrive with its tests, as before — the gate no longer forgives accumulated debt.
