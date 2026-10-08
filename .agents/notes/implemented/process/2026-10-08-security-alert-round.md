# Agent Note: Close the October 2026 security-alert round

Status: implemented

English | [中文](2026-10-08-security-alert-round.zh.md)

## Problem

GitHub reported eight Dependabot alerts and one secret-scanning alert; code scanning had no analysis. The alerts named `@modelcontextprotocol/sdk` < 1.31.0 (the OAuth client forwards credentials to an authorization server chosen by the MCP server), `sharp` < 0.35.5 (librsvg memory-safety flaw, remote code execution on glibc Linux), `compression` < 1.8.2 (memory leak when a response closes early), `katex` < 0.18.2, `smol-toml` <= 1.8.0 (quadratic parsing), `source-map-js` < 1.2.2, `@vue/server-renderer` < 3.5.42, and `sprintf-js` <= 1.1.3. The Dependabot version PRs for two of them would not have closed the alert: the `smol-toml` override held 1.7.1 below the bump, and `katex` 0.16.47, reached through `mermaid` and `micromark-extension-math`, has no patched release in its line. The secret alert was a Telegram-token-shaped literal in a test.

The [earlier floor pins](2026-09-05-pin-transitive-security-floors.md) cover the same mechanism for a different alert set.

## Decision

Direct dependencies move to the first patched release. `mcp-client` and `ssh` require `@modelcontextprotocol/sdk` `^1.31.0`, which raises the declared floor above the vulnerable range, and the lockfile resolves 1.31.0. `attachment-local`, `apps/desktop`, `webserver`, and `ui-primitives` take `sharp` `^0.35.5`, `compression` `^1.8.2`, and `katex` `^0.18.2`; the root takes `smol-toml` `^1.9.0`.

The `pnpm-workspace.yaml` overrides cover what no manifest declares: `smol-toml: 1.9.0` replaces the old 1.7.1 pin, `katex: 0.18.2` collapses the 0.16 and 0.18 lines into one version, `source-map-js: 1.2.2` covers the `postcss` and Vue compiler consumers, and `vue: 3.5.42` brings the `@vue/*` packages it pins exactly (VitePress documentation build only).

`attachment-local` loads `sharp` through `requireSharp`, which blocks the libvips `VipsForeignLoadSvg` operation once per process. SVG is not an accepted attachment format, so untrusted bytes never reach librsvg, not even to be rejected afterwards. Raster decoding is unchanged.

`sprintf-js` has no patched release (1.1.3 is the latest) and reaches the workspace only through `electron-builder` → `@electron/get` → `global-agent` → `roarr`, a desktop-packaging chain. The alert is dismissed as tolerable risk rather than worked around with a fork.

Tests build token-shaped fixtures at runtime (`123456789:${'x'.repeat(35)}`) so no literal matches a provider secret pattern.

Every workflow uses `actions/download-artifact@v8`, matching the Python release workflows. The release, vendor release, and Landlock release workflows download by `name` or `pattern` only, so the v5 change to single-artifact-by-ID paths does not apply.

## Alternatives considered

**Merge each Dependabot PR.** Rejected: five PRs rewrite `pnpm-lock.yaml`, so they conflict serially and each waits for a full CI run, and two of them leave their alert open.

**Rely on the `sharp` upgrade alone.** Rejected: the upgrade closes the advisory, but the SVG decoder serves no supported format, so removing it costs nothing and shrinks the attack surface for the next librsvg flaw.

**Take Dependabot's `actions/download-artifact` v7.** Rejected: the Python workflows already use v8, and one major version per action keeps the workflows uniform.

**Fork or vendor `sprintf-js`.** Rejected: the only consumer is a packaging-time chain, and a fork would own a library whose upstream has not published a fix.

## Consequences

The lockfile resolves no version inside any of the eight alert ranges except `sprintf-js`. `katex` runs as one 0.18 version everywhere, including the documentation site's `mermaid`. The `sprintf-js` alert stays dismissed until upstream publishes a fix; removing the dismissal then needs only an override.

`pnpm run build` and the suites for `mcp-client`, `ssh`, `webserver`, `ui-primitives`, `attachment`, `tool-fs`, and `chat` pass on the new resolution. `image.spec.ts` pins the SVG block through `requireSharp`.
