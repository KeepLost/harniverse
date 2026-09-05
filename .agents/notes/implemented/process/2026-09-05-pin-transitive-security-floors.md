# Agent Note: Pin security floors for transitive dependencies

Status: implemented

English | [中文](2026-09-05-pin-transitive-security-floors.zh.md)

## Problem

Dependabot opened 17 alerts (7 high, 9 moderate, 1 low) against `pnpm-lock.yaml`, all on packages the workspace declares only transitively: `hono` < 4.12.34 and `qs` < 6.16.0 reach the runtime closure through `@modelcontextprotocol/sdk` (via `@hono/node-server` and `body-parser`→`express`), `fast-uri` < 3.1.6 through `ajv`, `browserslist` <= 4.28.6 through the CSS/browser toolchain, and `undici` 8.x < 8.9.0 through the `undici8` optional-peer alias that `e2b` and `vitest` consume. No workspace manifest pins these names directly, so no `package.json` range edit could reach them.

## Decision

Extend the existing `overrides` block in `pnpm-workspace.yaml` — the same mechanism already holding `brace-expansion`, `dompurify`, `nanoid`, `postcss`, `protobufjs`, and `undici@7` floors — with major-scoped pins for each vulnerable range: `browserslist@4: 4.28.7`, `fast-uri@3: 3.1.6`, `hono@4: 4.12.34`, `qs@6: 6.16.0`, `undici@8: 8.9.0`, plus `undici8: undici@8.9.0` because pnpm matches alias dependencies by their declared name, not their target. Every pin is the first patched release, no lower than the previously resolved version.

## Alternatives considered

**A broad `pnpm update`.** Rejected: it would churn unrelated resolutions across the lockfile and make the security fix unauditable from the diff.

**`pnpm.overrides` in the root `package.json`.** Rejected: pnpm 11 no longer reads the `pnpm` field there; the install warns that the keys were ignored, and the overrides silently do nothing.

**Leaving dev-tool-only alerts unresolved.** Rejected: the same lockfile feeds every CI lane and the packed artifacts, so toolchain transitives are part of the shipped attack surface.

## Consequences

The lockfile now resolves zero vulnerable versions for the five flagged packages while `undici@7` stays at its existing floor for the runtime paths that require it. `pnpm run build`, the license/runtime-closure/third-party-notices hygiene gates, and the MCP SDK consumers' suites (`mcp-client`, `subagent-claude-code`, `llm-pi-ai`, 355 tests) pass on the patched resolution.
