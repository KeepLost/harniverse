# @deepseek-ai/dsh-mcp-user-config

English | [中文](README.zh.md)

Named Cordis consumer that reads the host-owned `mcp` settings namespace and mounts one `@deepseek-ai/dsh-mcp-client` child for every enabled user-configured server. The child keeps the existing single-server transport, reconnect, tool registration, and capability-disclosure contract.

## Usage

Mount the same named plugin once with `role: provider` in the host/base scope, then mount it with `role: consumer` from every profile that should receive MCP tools. The provider owns the single `mcp` settings registration; each consumer owns its own child clients:

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

- The provider validates and registers `mcp` once. Its capability adapter captures a private settings snapshot before a Profile generation mounts. Consumers mount only enabled, selected entries from that snapshot through real `ctx.plugin(mcp-client, config)` child fibers; secrets never enter generation signatures or catalog descriptors.
- Each consumer supplies an internal reservation owner key, so simultaneous Standard-family profiles can expose the same configured public `serverName` in separate scoped registries without weakening duplicate detection inside one consumer.
- One child's connection or startup failure is logged with only its stable identities and error kind; unrelated children continue to start.
- A disabled entry creates no child and therefore cannot register or disclose namespaced tools.
- Settings changes advance a provider-owned generation identity. The next Profile assembly captures the new settings; existing consumers retain their original clients, instructions, resources, and captured member permissions. Reconnects use that same captured configuration.
- Consumer disposal awaits every child. The child `mcp-client` owns process shutdown, tool and resource unregistration, capability updates, and server-name reservation release.
- Both roles declare host-available `settings` and `tools` injections. The provider uses `settings`; a consumer reads the optional `mcpUserConfigSettings` service with `ctx.get()` and uses its injected `tools` scope. Minimal can omit the consumer and therefore receives no MCP tools.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.mcpUserConfigSettings` | Read the captured generation snapshot, or current settings for a standalone consumer |
| `ctx.capabilities` | Optional private generation capture and server selection integration |
| `ctx.tools` | Required by each mounted `mcp-client` child for model-facing tool registration |

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
- Superseded Profile generations retain their clients until the owning standing scope is disposed; generation reclamation remains owned by `agent-presets`.
- Settings descriptors are safe only when a wire consumer requests `ctx.settings.describe({ redactSecrets: true })`; `env` and `headers` values are declared with `role('secret')` for that redaction path.
- Host/base owns the provider row; Standard, Code, and Cordis own consumer rows. Custom compositions must preserve that one-provider, scoped-consumer split.
