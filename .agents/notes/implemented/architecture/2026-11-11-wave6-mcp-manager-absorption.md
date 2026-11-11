# Agent Note: Wave-6 MCP manager absorption (probe, watch, plugin-registered servers)

Status: implemented

English | [中文](2026-11-11-wave6-mcp-manager-absorption.zh.md)

## Problem

Upstream `dsh-mcp-manager` (0.2.2 line) carries three fleet capabilities harniverse's `mcp-user-config` pair lacked: a `probe` that tests one server configuration without mounting it, a `watch` stream that pushes fleet changes to management surfaces, and plugin-registered servers that join the fleet for their registering plugin's lifetime. Harniverse already had the status/restart Remote and shared connections; the deltas were the absorption targets (ledger row 5, deltas 2/3/4).

## Decision

Absorb all three onto the existing machine-owned fleet, keeping the wave-3 config-ownership divergence and the W07 host-shared-connection + scoped-registrar model:

- **`probeServer(config, options)`** joins `dsh-mcp-client` as a standalone export: connect through the shared transport factory, read the server identity, page `tools/list` under explicit caps (`timeoutMs` whole-probe budget, `maxPages`, `maxToolNames`, `signal`), close under a bounded grace. It registers nothing and reserves no namespace; failures return a stage-classified `McpProbeResult` (new public `./types` subpath) with an independently settled cleanup outcome instead of throwing.
- **`mcpManagement.probe(serverId)`** (`harniverse.administer`) probes any configured or registered entry — disabled entries answer too, so the settings page can trial before enabling.
- **`watch` lands as `mcpManagement/fleet-changed`**: the upstream stream assumes stream-mode Remotes, which harniverse's typert protocol does not have. The management service instead subscribes the shared-connection registry (membership and owner replacement) plus each live handle's change feed (state transitions), and emits one payload-free, contained `@mode emit` cordis event after every change commits. The event joins `API_REMOTE_FORWARDED_EVENTS`; the settings page re-joins immediately on it and keeps its 5 s poll as fallback.
- **Plugin registrations**: `ctx.mcpUserConfigRegistrations.register(serverName, entry)` contributes one server for the calling plugin's lifetime. The entry carries every configured field except `id`/`enabled`/`serverName`, is validated like a configured entry, mounts under a minted `registered-<serverName>` id, and shares the `serverName` namespace with Settings in both directions — a registration refuses a configured name and the settings validator (closing over the live registration set) refuses a registered name. Removal — the returned disposer or the plugin fiber owning the wrapping `ctx.effect` — awaits the shared owner's teardown, so tools withdraw before plugin disposal settles. Registered servers join the capability catalog read-only (`manageable: false`), mount scoped registrars in every profile on the live plane (the consumer follows the registration set, not its captured generation), appear in `status()` rows with `source: 'registered'`, and never render editable settings rows.
- The settings page renders the probe action per card (probing/done views with localized summaries), the registered badge with fleet actions but no edit/delete/toggle, and re-joins on every forwarded fleet change.

## Alternatives considered

**Port the upstream watch stream verbatim.** Rejected: it requires `@Remote({ mode: 'stream' })`, a typert protocol evolution far out of proportion to the batch; the forwarded-event + re-join channel delivers the same user-visible behavior on harniverse's existing wire.

**Registrations through the capability-capture path.** Rejected: a registration is a live plugin effect, not a generation-scoped selection — capturing it would strand stale tools after plugin disposal. The consumer follows the live set while settings entries stay capture-pinned.

## Consequences

A plugin can now ship an MCP server that every profile sees while it is registered, the settings page can test any entry before enabling it, and fleet state changes reach the page the moment they commit. Status rows grow the additive `source` discriminator; the catalog, subsystems pages (`tools.md`/`settings.md`), api-catalog, and generated typert artifacts carry the new faces. Wire streaming remains the recorded ceiling: a future stream-mode Remote can replace the event+poll channel without touching the service seam.
