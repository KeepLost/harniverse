# Agent Note: Private destinations enabled in the product composition's browser panel

Status: implemented

English | [中文](2026-10-15-browser-panel-private-destinations.zh.md)

## Problem

The workspace browser panel refused intranet navigation with `the operator has not enabled private destinations`. `browser-controller`'s schema defaults `allowPrivateAddresses` to false (an upstream operator opt-in: page traffic leaves the host's network position, so the default denies its loopback/link-local/private neighbourhood), and the Harniverse web-app composition shipped the row with no config — so the product denied exactly the destinations its workspace browser exists to reach.

## Decision

**The Harniverse composition opts in; the upstream package default stands.** `packages/bundle/web-app/cordis.patch.yml` sets `allowPrivateAddresses: true` on the shipped `browser-controller` row, with `allowedHosts` left empty (every host) so a deployment can still confine navigation per site. The config seam stays the operator's: the schema default, the `reviewNavigation` policy, and the per-deployment override path are untouched, preserving the plugin-native architecture — a Harniverse product decision expressed as composition config, not a fork of the package. The desktop qualification snapshot (`apps/desktop/scripts/packaging-browser.ts`) previously *inserted* a full config block after the row's `name:` line; it now patches idempotently across both shapes it can meet — the current bundle's row (which already carries `allowPrivateAddresses: true`, so only the `allowedHosts: ['127.0.0.1']` confinement and the observer are added) and the already-published tarball's bare row (config inserted as before) — so a packaged runtime never ends up with two `config:` blocks under one row.

## Alternatives considered

**Flipping the package schema default to true.** Rejected: the upstream default-deny is a real operator posture for a host-position browser (the package README documents it); Harniverse's need is a product-composition fact and belongs at the composition seam, where a stricter deployment can still override it back.

**Requiring operators to write config per deployment.** Rejected: Harniverse's stated purpose for the panel is private-network reach; shipping a product whose headline capability needs an undocumented config flip is the defect, not the fix.

## Consequences

The workspace browser navigates `10.x`/`172.16.x`/`192.168.x`, `.local`, and loopback hosts out of the box; public navigation is unchanged; a deployment can still set `allowedHosts` or override `allowPrivateAddresses: false` through ordinary config layering. The desktop packaging fixture gained the shipped config shape, keeping the qualification snapshot's patch idempotent against the real bundle.

Verification: `packages/bundle/web-app` suite (30 files, 423 tests across the four touched packages) stays green over the new composition; the desktop `packaging-browser` node:test suite (12 tests) drives both shipped shapes through the patch step, asserting exactly one `config:` block and that the sealed source keeps its bytes.

PR: #191 (merge)
