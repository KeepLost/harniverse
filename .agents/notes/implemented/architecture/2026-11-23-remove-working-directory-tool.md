# Agent Note: Removing the model-facing `working_directory` tool

Status: implemented

English | [中文](2026-11-23-remove-working-directory-tool.zh.md)

## Problem

`tool-working-directory` shipped a model-facing `working_directory` tool (read the effective directory, or `cd` into another) beside the `working-directory` service. The official 0.2.3 `session-workspace-root` record published usage evidence from their fleet: of 6,229 tool calls in sampled sessions the model used `working_directory` once, while 61% of shell commands already carry their own `cd` prefix. The tool also let the model drag the session anchor — the effective directory every consumer (file views, edit boundaries, injected context) resolves against — away from the header cwd that remains the identity and sandbox root, so a rarely-used tool carried an anchor-drift cost.

## Decision

- Delete `packages/session/tool-working-directory` and every composition row: base bundle, web-app disable row, all four CLI agent presets, the agent-presets package mapping, the tool catalog, and the module graphs. The model keeps no `working_directory` tool.
- The `working-directory` **service stays unchanged**: `header.cwd` remains the immutable identity and sandbox root; `working-directory/change` events, the folded projection, the `working-directory:current` context, and the per-change notice keep working for their real owners (`create_worktree`, sandbox escalations, future programmatic entries).
- `create_worktree`'s description — the only model-visible text that referenced the tool — now says to change the directory back with the model's shell; the worktree, checkout, and branch semantics are unchanged.

## Alternatives considered

- **Keep the tool** — one fleet-sample use in 6,229 calls does not pay for a second directory surface beside `cd`, and anchor drift is a real cost on every consumer of the effective directory.
- **Keep it out of shipped presets only** — a dormant composition row still pays catalog, schema, and review cost for a capability the evidence says the model does not use.

## Consequences

- The wire tool list shrinks by one on every shipped composition (base, web, CLI presets); the minimal preset now exposes `[shell, str_replace_editor]`. Sessions that logged `working_directory` calls replay their recorded results unchanged — durable history is untouched.
- The model changes directories exactly the way the evidence says it already does: `cd` inside its shell calls. Sessions wanting a model-visible directory read keep the injected `working-directory:current` context line.
- Evidence: composition suites (`apps/web/tests/shipped-composition.e2e.ts`, `minimal-preset.snapshot.ts`) and the tool-catalog generation suite updated and green; `agent-presets`, `tool-worktree`, and `working-directory` suites unchanged-and-green (173 pass); catalogs and graphs regenerated.
