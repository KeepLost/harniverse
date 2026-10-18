# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

Browser settings section (`mcp`, ordered after Governor and before Agent Presets) that manages this machine's user-configured MCP servers. The page lists every configured server with its live connection state, edits and enable/disable toggles ride the `mcp` settings scope (via `ctx.settingsScope`), live state and in-place restart ride the `mcpManagement` Remote, and each card shows which presets expose the server through capability composition. Configuration, connections, and restart all live on the machine the page is connected to.

## What the page does

- **Server cards**: public namespace, transport, live state band (connected / connecting / reconnecting with attempt counters / retries exhausted / stopped / disabled), online-since and last-error kind, the server's current tool inventory (expandable), and the preset references whose compositions select this server.
- **Add / edit**: one modal form covering both transports (`stdio` command/args/env/cwd and `streamable-http` url/headers) plus `toolCallTimeoutMs`, `maxInstructionBytes`, and `failOnStartupError`. Identity (`id`) and namespace (`serverName`) are validated against the settings schema's own rules before any write.
- **Secrets are write-only**: `env` and `headers` values ride the settings wire as secret fields and are never echoed back into the form. A key whose line is deleted is removed; a key with an empty value keeps the stored one.
- **Paste import**: accepts OpenCode `mcp` configuration (including the standard `mcpServers` shape and a bare single-server object), previews the recognized servers, skips ids that already exist, and imports the rest as enabled rows.
- **Restart**: recreates one enabled server's shared connection through the Remote (requires the `harniverse.administer` capability); a rejected restart surfaces its message inline.

## Data faces

| Face | Direction |
|---|---|
| `ctx.settingsScope` bound to namespace `mcp` | Durable rows; every add/edit/toggle/delete writes through `set('servers', …)` |
| `ctx.remote.mcpManagement` (`status()`, `restart()`) | Live fleet state and in-place restart; joined every refresh and polled at 5 s while the section is open |
| `ctx.connection.api.agentPresets.list` + `ctx.remote.capabilityManagement.catalog` | Read-only preset references: which profiles' compositions select each server |

## Model Experience

None, as this page never enters a model request; the `mcp-user-config` settings namespace and the shared connections it shapes own every model-facing effect.

#### KV Cache effect

No direct invalidation. Editing servers changes future profile compositions through the owning packages; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

- Live state is polled (5 s while the section is open); the management Remote does not stream fleet events.
- The import parser accepts the OpenCode `mcp` / standard `mcpServers` JSON shapes only; other export formats are out of scope.
- The page manages the machine it is connected to. Per-remote-host MCP rosters are deferred until remote hosts expose their own management Remote.
- Preset references are read-only; changing a preset's MCP selection happens on the preset's own capability surface.
