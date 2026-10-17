# Agent Note: Shared MCP connections with scoped preset registration

Status: implemented

English | [中文](2026-10-14-shared-mcp-connections.zh.md)

## Problem

MCP servers configured through the `mcp` settings namespace ran one connection per profile: every consumer of `dsh-mcp-user-config` mounted its own `mcp-client` child, so three profiles exposing the same server spawned three server processes, three discovery passes, and three reconnect machines — while the settings page could not see or repair any of them. The web GUI had no MCP surface at all; the community plugin `dsh-mcp-manager-plus` writes old-style `cordis.patch.yml` rows, which the profile format no longer accepts.

## Decision

Connections are Host-global; registration stays per-profile. The split lives inside `dsh-mcp-client` so both modes share one exposure path:

- `McpConnectionsRegistry` (`ctx.mcpConnections`) owns one transport-only supervisor per settings id. `McpOwnerPlugin` mounts one supervisor as a child fiber; it never registers tools.
- `McpRegistrarPlugin` attaches to a running shared connection by settings id and projects the tool inventory into its own scoped `ctx.tools` layer, under the same public naming, capability, and prompt-section rules as standalone mode (`exposeScopedServer` is the single exposure path both modes call).
- `dsh-mcp-user-config`'s provider mounts the owner fleet (serialized through a fleet chain; only a changed configuration signature remounts an owner); each consumer mounts one registrar per enabled, selected entry of its captured generation.

Permission isolation is unchanged: a preset still decides exposure through capability composition, so two profiles on the same connection can carry different member selections. Per-machine scope falls out of the design — the `mcp` settings namespace is excluded from remote-host sync, and connections live in the Host process that owns the settings.

### Semantics changes

- One shared owner per server: `failOnStartupError` is a standalone-mode switch; a shared owner's startup failure is contained by the fleet step and surfaces through the registry.
- Renaming a `serverName` keeps the settings id, so the connection slot survives while the public namespace moves. A generation pinned before the rename keeps its captured member selection but follows the live connection; a slot removed from settings fails its registrars with `unknown server`.
- The server's instructions prompt section follows the live connection, not the captured generation.

## Management surface

`McpManagementService` (Typert namespace `mcpManagement`, both operations gated by `harniverse.administer`) serves `status()` — one row per settings entry with live state, attempt counters, tool inventory, and connection epoch — and `restart(serverId)`, whose validation (`unknown server`, `server "X" is disabled`) lives in the fleet step so a restart cannot bypass settings. The browser plugin `dsh-client-ui-settings-mcp` renders the Settings section (id `mcp`, order 17) over the settings scope, this Remote, and read-only preset references from the capability catalogs; live state is polled at 5 s while the section is open. Import accepts the OpenCode `mcp` JSON (plus the standard `mcpServers` shape and a bare single-server object).

## Verification

- `packages/mcp/mcp-client/tests/shared-connection.spec.ts` covers the registry, owner/registrar lifecycle, and scoped registration under connection churn (178 tests package-wide, 100 % per-file coverage).
- `packages/mcp/mcp-user-config/tests/` covers the fleet (remount discipline, generation capture, one-owner-per-server) and the Remote's projection and validation (40 tests).
- `packages/client/ui-settings-mcp/tests/` covers registration/HMR disposal, the joined store, the parser, and every component branch (89 tests, per-file 100 % coverage).

## Alternatives considered

**One registrar per server with reference counting.** The registry could have exposed raw connections and let each preset registrar hold its own transport client, closing when the last reference left. That keeps `mcp-client` standalone-shaped, but a reconnect would have to be replayed per registrar, discovery results can drift between profiles on the same server, and the settings page still has no single owner to ask for status. It lost to the owner/registr split, which pays one supervisor per server and makes status a registry read.

**Keep per-profile connections, add only the management surface.** The original pain — three processes for one configured server — would have remained; management would report three rows for one settings entry and `restart` would need a fan-out with partial-failure semantics. Rejected as a patch around the actual defect.

**Centralize registration in the owner.** Letting the owner expose tools directly would make exposure host-global and break the permission model: member selection is a per-preset decision owned by capability composition. The registrar child keeps that boundary at the cost of one fiber per (preset, server) pair.

## Consequences

The host runs at most one connection per settings id regardless of how many profiles select it — fewer server processes, one discovery pass, one reconnect machine — but shared ownership makes the failure semantics coarser: a server that fails to start reports through the fleet step instead of failing the mounting profile, and `failOnStartupError` no longer applies outside standalone mode. The split adds a second plugin pair in `dsh-mcp-client` (owner, registrar) plus a registry service, and the fleet signature remount means a settings edit restarts the affected connection rather than patching it live. What it bought: the settings page finally sees and can repair every connection, presets keep isolated member selection over one shared transport, and the exposure contract (`exposeScopedServer`) stays single-sourced between standalone and shared modes.
