# Agent Note: Read-only plugin diagnostics

Status: implemented

English | [中文](2026-08-18-read-only-plugin-diagnostics.zh.md)

## Problem

Cordis exposes plugin lifecycle state through several independent owners: Host Loader entries, standing agent-preset mounts, retained dynamic package attempts, and one browser Cordis root per page. Loader `ACTIVE` means activation completed; it does not prove that a plugin remains healthy. Operators had an inventory view but no structured way to distinguish a missing dependency, a failed activation, a transition, or a diagnostic check that failed to observe its target. Copying OpenClaw Doctor's mutation-capable command model would also let an observation path restart, rewrite, or delete state based on incomplete point-in-time evidence.

## Decision

`@deepseek-ai/dsh-plugin-diagnostics` is the Service Definition and coordinator. `ctx.pluginDiagnostics.register()` owns contributions through Cordis effects, while `diagnose()` snapshots the current checks, executes them sequentially, and returns a sorted `PluginDiagnosticReport`. Every finding carries stable attribution, severity, domain, human-readable observation, and optional path and textual response hint. Check exceptions are logged on the Host and become generic findings, so one broken check neither aborts the report nor sends exception details over the wire.

`@deepseek-ai/dsh-plugin-diagnostics-cordis` is the shipped Provider. It contributes checks for enabled Host Loader roots, live standing preset roots, and retained dynamic Cordis attempts. The checks query owner inventories when diagnosis runs and publish service names or lifecycle phases only. Dynamic exception text, stack traces, package source, configuration, and credentials never enter findings. Browser-page Cordis roots remain outside Host diagnosis because the Host has no authoritative view of their complete local plugin tree.

The existing `PluginInventoryGateway` is the Consumer and wire adapter. Its `pluginInventory/diagnose` Remote requires `harniverse.observe`, alongside the existing inventory operation. The existing Web Plugins settings tab loads inventory and diagnosis together and renders severity, code, message, path, and textual guidance. Neither the service, Provider, Remote, nor UI defines repair, restart, retry, disable, delete, configuration-write, or process-control operations.

The report is point-in-time and advisory. `ACTIVE` produces no finding but never acts as a health certificate. Pending and transient states do not trigger actions. A textual hint can tell an operator what fact to verify, but no caller can feed that hint back into this capability as an executable command.

## Alternatives considered

**A Doctor-style detect-and-repair interface.** OpenClaw Doctor demonstrates useful stable check ids and failure isolation, but its ordinary path has historically mixed observation with writes and restarts. Harniverse keeps repair outside this capability until an independently authorized operation can prove ownership, freshness, idempotence, and postcondition verification.

**Checks embedded in `PluginInventoryGateway`.** This would couple every lifecycle owner to a Host Remote package and make non-Web consumers depend on the wire adapter. An effect-scoped registry preserves plugin ownership and lets other report consumers join without moving checks.

**A separate diagnostics Settings plugin.** Inventory and diagnosis describe the same deployed plugin set and share authorization, loading, retry, and empty-state behavior. Extending the existing tab avoids another navigation contribution and Remote adapter.

**Diagnosing browser Cordis roots from the Host.** Browser roots are per-page and may differ during loading, HMR, reconnect, or tab closure. Treating one client report as Host truth would merge authority domains and create stale repair pressure, so the first release stays Host-owned.

## Consequences

Operators receive one structured, safely authorized report over the existing plugin settings path, and package authors can add checks without editing the registry or gateway. Effect ownership removes contributions during reload, while failure containment keeps partial reports available. The cost is intentionally limited scope: reports have no durable incident history, no automatic refresh, no browser-root diagnosis, no check timeout policy, and no repair path. Future remediation requires a separate decision and capability rather than adding a callback to diagnostic findings.
