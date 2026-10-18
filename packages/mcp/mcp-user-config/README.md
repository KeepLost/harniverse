# @deepseek-ai/dsh-mcp-user-config

English | [中文](README.zh.md)

Named Cordis plugin pair over the host-owned `mcp` settings namespace. The provider mounts one host-shared `mcp-client` owner per configured server — a single connection per server for the whole Host — and each profile's consumer mounts registrar children that project the shared connections' tools into that profile's own scoped `ctx.tools` layer. The settings page (`dsh-client-ui-settings-mcp`) edits the same namespace and reads live state through this package's `mcpManagement` Remote.

## Usage

Mount the same named plugin once with `role: provider` in the host/base scope, then mount it with `role: consumer` from every profile that should receive MCP tools. The provider owns the single `mcp` settings registration and the shared connection fleet; each consumer owns its registrars:

```ts
import {
  Config,
  apply,
  inject,
  name,
} from '@deepseek-ai/dsh-mcp-user-config'

declare const ctx: { plugin(...args: unknown[]): Promise<unknown> }
declare const profileContext: typeof ctx

await ctx.plugin({ name, inject, Config, apply }, { role: 'provider', servers: [] })
await profileContext.plugin({ name, inject, Config, apply }, { role: 'consumer', servers: [] })
```

The provider's composition config is a base layer. User-owned values belong in `$DSH_HOME/settings.yaml` under the `mcp` namespace:

```yaml
mcp:
  servers:
    - id: github
      serverName: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: '<write-only value>'
    - id: local-docs
      enabled: false
      serverName: local-docs
      transport: streamable-http
      url: http://127.0.0.1:3000/mcp
```

The shipped Standard, Code, and Cordis profiles mount the consumer; Minimal does not. A custom profile still decides whether this plugin is present.

## Configuration

`Config` is the single named-plugin row schema. `role` defaults to `consumer`; provider rows use `servers` as the composition base, while consumer rows leave `servers` empty. `SettingsConfig` is the schema for the provider's `mcp` settings section. The `servers` array defaults to empty, and each `enabled` field defaults to `true`.

| Field | Transport | Required | Description |
|---|---|---|---|
| `role` | both | no | `provider` registers the shared settings scope; `consumer` reads it and mounts profile-local children; default `consumer` |
| `id` | both | yes | Stable identity of a configured server within each generation; `[A-Za-z0-9_-]{1,64}` |
| `enabled` | both | no | Disabled entries are not mounted and disclose no tools; default `true` |
| `serverName` | both | yes | Stable `mcp-client` namespace for model-facing names; `[A-Za-z0-9_-]{1,32}` |
| `transport` | both | yes | `stdio` or `streamable-http` |
| `command` | stdio | yes | Executable passed to the MCP SDK transport |
| `args` | stdio | no | Direct child-process arguments; default `[]` |
| `env` | stdio | no | Extra child environment values; default `{}` and redacted as secret fields |
| `cwd` | stdio | no | Child working directory; default `''` |
| `url` | streamable-http | yes | MCP endpoint URL |
| `headers` | streamable-http | no | Request headers; default `{}` and redacted as secret fields |
| `toolCallTimeoutMs` | both | no | Per-tool-call timeout; default `60000` |
| `maxInstructionBytes` | both | no | Positive safe-integer UTF-8 budget including server attribution; default `32768` |
| `failOnStartupError` | both | no | Make this child report startup failure to the bridge; default `false` |
| `reconnect` | both | no | Existing `mcp-client` reconnect policy; defaults are enabled, 500 ms, 30000 ms, and 10 attempts |

`id` and `serverName` must each be unique across the complete array. Missing transport fields, transport-inappropriate fields, duplicate identities, unknown fields, and invalid child options fail closed before a child is mounted. A rejected settings write leaves the last good resolved section in place.

## Lifecycle

- The provider validates and registers `mcp` once, then mounts one `McpOwnerPlugin` child per settings entry — including disabled ones, which stay as stopped owners so enable writes never create a fiber race. Owners mount serialized through a fleet chain, and a changed configuration signature (not a transient reconnect state) remounts exactly the changed owner. Owner activation never waits for a first connection attempt: every connection starts immediately and proceeds in the background in parallel, so Host startup — and the web listener riding it — is never delayed by a slow or unreachable server.
- One owner's connection or startup failure is contained by the fleet step and logged with only its stable identities and error kind; unrelated owners continue to start. `failOnStartupError` is a standalone-mode switch and is ignored for shared owners.
- Consumers mount one `McpRegistrarPlugin` child per enabled, selected entry of the captured generation snapshot. A registrar attaches to the live shared connection by settings id and re-syncs its scoped tool registration on every registry push; it never owns a transport.
- Renaming a server's `serverName` keeps the settings id — and therefore the shared connection slot — while the public namespace moves. A pinned generation keeps its captured member selection; a slot removed from settings fails its registrars everywhere with `unknown server`, and the server's instructions follow the live connection, not the captured generation.
- Settings changes advance a provider-owned generation identity. The next Profile assembly captures the new settings; existing consumers keep their registrars until their owning scope is disposed. Secrets never enter generation signatures or catalog descriptors.
- Consumer disposal awaits every registrar; provider disposal awaits the fleet and shuts down every shared connection. The `mcp-client` core owns process shutdown, tool and resource unregistration, capability updates, and server-name reservation release.
- Both roles declare host-available `settings` and `tools` injections. The provider uses `settings`; a consumer reads the optional `mcpUserConfigSettings` service with `ctx.get()` and uses its injected `tools` scope. Minimal can omit the consumer and therefore receives no MCP tools.

## Management Remote

`McpManagementService` (Typert namespace `mcpManagement`, both operations gated by `harniverse.administer`) projects the fleet for the settings page:

| Operation | Result |
|---|---|
| `status()` | One row per settings entry: stable id, `serverName`, transport, live connection state (`connecting`/`connected`/`reconnecting`/`exhausted`/`stopped`/`disposed`, or `disabled`), failed-attempt counters, current tool inventory, and the epoch of the current connection generation |
| `restart(serverId)` | Recreate one enabled server's shared connection; validation (`unknown server`, `server "X" is disabled`) lives in the fleet step, so a restart cannot bypass settings |

## Services consumed

| Service | Usage |
|---|---|
| `ctx.mcpUserConfigSettings` | Read the captured generation snapshot, or current settings for a standalone consumer |
| `ctx.mcpConnections` | Shared-connection registry the owners create into and the registrars attach through |
| `ctx.capabilities` | Optional private generation capture and server selection integration |
| `ctx.tools` | Required by each registrar for model-facing tool registration |

## Model Experience

### User-configured MCP tools

#### What the model sees

After discovery, the model sees namespaced tools `mcp__<serverName>__<rawName>`, selected server instructions, and the shared resource tools when the host composes `mcp-resources`. Each client discloses concrete resource and template members alongside tool members through its capability adapter.

#### Token effect

Every enabled server contributes the data-dependent schema cost of its discovered tools on each request. Disabled or failed entries contribute no tool schemas; the namespace prefix adds tokens to each visible definition and call.

#### KV Cache effect

The prefix stays stable while the captured servers' discovered tools and instructions stay unchanged. Settings edits change future generations; existing Sessions and children joined to their generation retain their original composition.

## Known Limitations and Deferred Work

- MCP server-defined prompts remain deferred. Resources require the host-owned `mcp-resources` service.
- Superseded Profile generations retain their registrars until the owning standing scope is disposed; generation reclamation remains owned by `agent-presets`.
- Settings descriptors are safe only when a wire consumer requests `ctx.settings.describe({ redactSecrets: true })`; `env` and `headers` values are declared with `role('secret')` for that redaction path.
- Host/base owns the provider row; Standard, Code, and Cordis own consumer rows. Custom compositions must preserve that one-provider, scoped-consumer split.
- A pinned generation rides the live shared connection: a server renamed after capture exposes the new public namespace to old registrars too, and a removed slot strands them until their scope is disposed.
- The management Remote reports state; it does not stream it. The settings page polls `status()` (5 s while open) rather than subscribing to fleet events.
