# Agent Note: Shipped composition bridges every auth startup field

Status: implemented

English | [中文](2026-09-19-auth-composition-bridge-guard.zh.md)

- Date: 2026-09-19
- Scope: `@deepseek-ai/dsh-auth-app` (bundle composition, tests)
- PR: pending (this note ships with the fix)

## Problem

`dsh auth code issue --profile owner --ttl 30m` failed in production with `auth-runner: code-issue requires --ttl` although the flag parsed correctly. The bundle's shipped `cordis.patch.yml` bridges `authStartup` service fields into the runner row's Loader config with one `!!js` line per field, and the invitation feature added `kind`, `bindName`, `ttl`, and `count` to `AuthStartupValues` without adding their bridge lines. The package tests boot a hand-written fixture composition that carried the new fields, so every test stayed green while the shipped composition dropped the values.

## Decision

- The runner row in `cordis.patch.yml` now bridges every `AuthStartupValues` field, the four invitation fields included. The bridge is product surface, not an implementation detail.
- `auth-app.spec.ts` now asserts that each field the startup service publishes at runtime appears as `!!js ctx.authStartup.<field>` in the shipped patch file, so a future field without a bridge line fails the suite instead of failing in production.

## Consequences

- `dsh auth code issue|list|revoke` works through the real launcher again; verified end to end (issue, list, revoke, exit 0 each).
- Any plugin whose Loader-row config is fed from a service through `!!js` treats its composition file as code: extend it in the same commit as the service fields, and guard the pairing from runtime evidence rather than a fixture copy.

## Alternatives considered

- **Booting the shipped patch file directly in tests:** rejected — the fixture exists to point at in-tree `src/` through mjs shims; importing the patch wholesale would rebuild that indirection.
- **Deriving the bridge from the `Config` schema:** rejected — the schema lives in the runner while the bridge names the startup service's published keys; runtime evidence couples both sides.
