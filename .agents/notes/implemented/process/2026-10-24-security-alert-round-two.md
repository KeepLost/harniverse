# Agent Note: Close the second October 2026 security-alert round

Status: implemented

English | [中文](2026-10-24-security-alert-round-two.zh.md)

## Problem

GitHub reported twenty-five open Dependabot alerts: fourteen `electron` advisories (43.0.0-alpha.1 through 43.7.x: SameSite windows from links, pointer-lock / `openExternal` / HID-USB permission attribution to the wrong frame or origin, extension `tabs.query` without the tabs permission, GPU-supplied frame geometry in frame subscription and macOS off-screen rendering), five `vite` 6 advisories (custom-middleware cross-origin script execution, `server.fs.allow` bypass on non-Windows, and three `launch-editor` command-execution flaws), three `dompurify` sanitizer bypasses (`SAFE_FOR_TEMPLATES` split expressions, `IN_PLACE` detached-subtree handlers, SMIL `attributeName=href` guard skip under XHTML media type), two `@vitest/mocker` advisories (unauthenticated manual-mock registration and a Windows backslash traversal around its allowlist fix), and one quadratic zone-identifier parse in `ip-address` 10.7.3. Dependabot PRs #203 (`ip-address`) and #204 (`electron`) were open against the same lockfile.

## Decision

Direct dependencies move to the first patched release: `apps/desktop` pins `electron` `43.7.6` (covering all fourteen advisories), the four `vitest` manifests (root, `apps/web`, `client-runtime`, `acp-snapshot`) take `^4.1.12`, whose resolver brings `@vitest/mocker` `4.1.12`, and the two `vite` 6 manifests move to `^6.4.4` (`website` from `^6.4.3`, `apps/web` from `^6.0.0`; both resolve 6.4.5, above the 6.4.4 floor).

The `pnpm-workspace.yaml` overrides cover the transitive resolutions: `dompurify` `3.4.17` replaces the 3.4.16 pin (mermaid and vitepress chains), `vitepress>vite` `6.4.4` replaces 6.4.3 (the documentation build's own vite 6 copy), and a new `ip-address: 10.7.4` floor pins every resolution under `express-rate-limit`, `mcp-client`, `ssh`, and the subagent packages.

## Alternatives considered

**Merge the open Dependabot PRs.** Rejected as the primary fix: #203 and #204 cover only two of the five packages, both rewrite `pnpm-lock.yaml` serially against the same overrides wall, and each waits on a full CI run; this round supersedes both.

**Override `@vitest/mocker` directly.** Rejected: it travels with `vitest` at one version per release, so raising the four `vitest` manifests to `^4.1.12` resolves it without a second pin.

**Jump `electron` to the 45.x line.** Rejected: every advisory is patched within 43.7.6, and the desktop runtime stays on the closest patch release instead of an untested major-line jump.

## Consequences

The lockfile resolves no version inside any of the twenty-five alert ranges: `electron` 43.7.6, `@vitest/mocker` 4.1.12, `dompurify` 3.4.17, `ip-address` 10.7.4, and vite 6 only as 6.4.4 (vitepress chain) and 6.4.5 (direct). The vite 6 pair stays two copies until the vitepress override retires; nothing consumes the difference. `pnpm install`, `pnpm run typecheck`, `pnpm run build`, `pnpm run test:gui` (7382 passed, 1 skipped), and `pnpm run test:desktop` all pass on the new resolution. #203 and #204 close automatically once the alerts they target resolve.
