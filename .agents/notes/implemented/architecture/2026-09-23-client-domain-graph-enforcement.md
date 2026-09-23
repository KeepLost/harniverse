# Agent Note: The client domain gate under-reported, then a sweep moved the shared contracts into contract/

Status: implemented

English | [中文](2026-09-23-client-domain-graph-enforcement.zh.md)

## Problem

`scripts/verify-client-domain-graph.ts` enforced the ui-conversation-era layering rule (a package's `src/client/` splits into `contract/` and domain directories that never import a sibling domain; only `apply`/`index` assemble) but the script itself had three defects: a relative specifier that climbed out of `src/client/` was treated as an intra-package import instead of being resolved and skipped, inline `import('…')` type references were invisible because only `from '…'` clauses were matched, and any subdirectory under `src/client/` was counted as a domain, so two-file component folders were reported as sibling-domain violations. After repairing the gate — specifier resolution with an escape hatch, three specifier patterns deduplicated by match offset, a `< 2` non-contract-directories early exit, and 1-based line numbers in the report — it found 24 real violations across `runtime` and `ui-conversation` that the broken gate had missed or misreported. The gate also ran only under the local `check:all` mode, which no CI lane executes, so none of this was enforced anywhere.

## Decision

Fix the gate, fix all 24 violations, and wire the gate into CI. In `runtime`, the outward sessions state model (list rows, list-store shape, subagent catalog snapshots, the session binding handle, the provide descriptors) moved into a new `contract/session-state.ts`; the conversation read model (`conversation.ts`, `pending.ts`, `context-provenance.ts` — the only data shape the logic layer feeds the UI, per its own header) moved into `contract/` as `conversation-snapshot.ts`; `WorkspaceListState`/`WorkspaceListPhase` moved into `contract/workspaces.ts`; the single-file `agents/` directory dissolved into the top-level `agent-scope.ts`; and `notifier.ts` moved to the top level where its two domains share it. In `ui-conversation`, the input contract (`input/contract.ts` → `contract/input.ts`), the composer block model (`input/blocks.ts` → `contract/input-blocks.ts`), turn metrics (`chat/turn-metrics.ts` → `contract/turn-metrics.ts`), the StatsLine pure helpers (extracted into `contract/chat-stats.ts`, the component stays in `chat/`), and `queueReadFaceOf` (into `contract/queue.ts`) all moved to the contract layer, while the sole-consumer files `tool-node-reader.ts` and `decorations.ts` moved next to their consumers in `skeleton/`. The gate is now a `client-domain-graph` step in both CI static lanes beside `verify-module-graph`, with a run-gates membership test pinning its presence in `ci-primary`, `ci-static`, and `check-all`.

## Alternatives considered

Re-export shims from `contract/` were rejected immediately: a shim that imports `../domain/…` is itself a contract→domain edge, so the gate would flag the shim. Keeping per-Workspace `section` state inside the workbench store (rather than the layout store, decided in the panel-relocation note) was unrelated to this sweep. Leaving single-directory packages under the sibling rule was considered and rejected: a package with one non-contract directory has no sibling to cross, and `packages/client/AGENTS.md` scopes the rule to places that "could later become separate packages".

## Consequences

Every cross-domain edge in the client packages now points one way (domain → contract), the gate reports zero violations, and CI enforces it on every pull request. The generated client slot catalog was regenerated for the new `WorkspaceListState` home. Package public APIs are unchanged — the barrel re-exports the same names from their new homes.

## Testing

`./node_modules/.bin/tsx scripts/verify-client-domain-graph.ts` (24 violations → clean); `pnpm run typecheck`; `NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run packages/client/runtime/tests packages/client/ui-conversation/tests --maxWorkers=1 --no-file-parallelism` (865 tests) plus per-file coverage gates on both packages; `NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run scripts/run-gates.spec.ts --maxWorkers=1 --no-file-parallelism` (44 tests including the three new membership cases).
