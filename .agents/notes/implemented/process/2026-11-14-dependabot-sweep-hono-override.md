# Agent Note: dependabot sweep — hono security floor and four compatible bumps

Status: implemented

English | [中文](2026-11-14-dependabot-sweep-hono-override.zh.md)

Date: 2026-11-14. Scope: `pnpm-workspace.yaml` (the `hono@4` override and `minimumReleaseAgeExclude`), `pnpm-lock.yaml`, `apps/web/package.json`, `website/package.json` (`@types/node`), `packages/vm/vm-qemu-local/README.md`(+zh, build-operation commands). One sweep branch merged the four compatible dependabot bumps and rejected the fifth.

## Problem

Five dependabot alerts were open — every one `hono` below 4.13.16, reached transitively under `@modelcontextprotocol/sdk` and `@hono/node-server` — while the workspace override still pinned `'hono@4': '4.13.11'` (the floor of the earlier GHSA-5r4p-p66f-jhc7 multipart DoS). Five dependabot PRs (#267–#271) sat open, days stale against an old master, their CI red from unrelated lanes. One of them (#269, vite 6→8.3.4) fought two documented holds in the workspace overrides.

## Decision

- **The security fix is the override, not a manifest bump:** `'hono@4': '4.13.16'` (comment extended to name both advisory families; `minimumReleaseAgeExclude` follows). Every hono resolution moves to the patched release and all five alerts clear. No source imports hono directly, so no code changes.
- **Four bumps taken through one sweep branch** (merged from the dependabot branches, lockfile conflicts resolved toward current dev state, then `pnpm install` normalized): `yaml` 2.9.0→2.9.1, `micromark-factory-space` 2.0.1→2.1.0, `cytoscape` 3.34.0→3.34.3, `@types/node` 22.20.0→26.6.5 (types-only; every importer resolves 26.6.5).
- **vite major rejected (#269).** Apps and the website keep vite 6 by documented decision: the vitest chain alone resolves the 8 line, held at 8.1.6 because it predates the vulnerable 8.3.0–8.3.2 launch-editor range and because newer toolchain releases shifted v8 coverage attribution off inline boolean callbacks; vite 8's rolldown CSS sheet order breaks the scrollbar-theme e2e cascade; and the `vitepress>vite: 6.4.5` override keeps one shared vite copy so the website config's `ViteDevServer` types stay structurally compatible — the exact type error #269's branch died on in `Pack npm tarballs`. The three 8-line CVEs are already covered by the 8.1.6 hold.
- **README build-operation commands** (owner request): the Assets section of `dsh-vm-qemu-local`'s README now spells out the one-time toolchain prerequisites, both build invocation forms, incremental-rebuild behavior, and the CI lane — bilingual.

## Alternatives considered

**Merge #269 as dependabot proposed.** Rejected: it contradicts two override-documented holds, and its own branch CI proved the break (website config type error under vite 8 types).

**Re-pin the vitest chain to the newest 8.3.8.** Rejected: the coverage-attribution hold (`esbuild@0.28: 0.28.1`, `ast-v8-to-istanbul: 1.0.4`) is blessed on 8.1.6; moving it re-opens the per-file 100% gate's attribution for no advisory gain — 8.1.6 is outside every open vite advisory.

**Bump hono per-manifest.** Rejected: nothing declares hono directly; the override is the workspace's single enforcement point for transitive security floors.

## Consequences

All five dependabot alerts close with the override bump. Dependabot #267, #268, #270, #271 close as landed through the sweep; #269 closes as rejected with the hold rationale recorded here and in the PR comment. The apps/website `@types/node` major is now 26 across the tree; CI lanes own the exhaustive validation.

## Testing

On the sweep branch after normalization: `pnpm run build` green; `pnpm run website:build` green (website back on the shared vite 6.4.5 copy); focused suites green (523 tests across `dsh-vm-qemu-local` and `dsh-app-boot`); `hono: 4.13.11` absent from the lockfile (4.13.16 ×3); README pairing re-recorded (1336 pairs consistent); md-wrap, doc budgets, note gates green. CI validates the frozen-lockfile consistency and the full lanes on the PR.

## Related

The override regime's history lives in `pnpm-workspace.yaml` comments; the vite holds trace to the scrollbar-theme e2e cascade and the coverage-attribution blessings named there.
