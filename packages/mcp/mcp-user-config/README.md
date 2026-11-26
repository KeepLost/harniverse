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
| `oauth` | streamable-http | no | OAuth 2.1 authorization: `true`, or an object with `clientId`, `scope`, `requestTimeoutMs` (default 10000), and `authorizationTimeoutMs` (default 600000); refused together with an `Authorization` header, on stdio, or with an endpoint that is neither HTTPS nor loopback HTTP |
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

`McpManagementService` (Typert namespace `mcpManagement`, all operations gated by `harniverse.administer`) projects the fleet for the settings page:

| Operation | Result |
|---|---|
| `status()` | One row per settings entry plus one per live plugin registration: stable id, `serverName`, transport, live connection state (`connecting`/`connected`/`reconnecting`/`exhausted`/`stopped`/`disposed`, or `disabled`), failed-attempt counters, current tool inventory, the epoch of the current connection generation, and `source: 'registered'` on plugin-registered rows |
| `restart(serverId)` | Recreate one enabled server's shared connection; validation (`unknown server`, `server "X" is disabled`) lives in the fleet step, so a restart cannot bypass settings |
| `probe(serverId)` | One-shot test of one configured or registered entry — connect, read the server identity, list tool names, close — without mounting an owner or reserving a namespace; disabled entries answer too, so a settings surface can trial before enabling |

Every fleet change (connection state moves, owner mounts/unmounts, settings or registration reshapes, authorization attempt phases) emits the payload-free `mcpManagement/fleet-changed` cordis event after it commits; listener failures are contained. The event is forwarded to web clients verbatim, and the settings page re-joins on it instead of waiting out its poll.

## OAuth authorization

A server whose entry carries `oauth` is authorized explicitly by the user; nothing in the fleet registers a client, redirects, or opens a browser on its own. The Remote drives one attempt per server:

| Operation | Result |
|---|---|
| `startAuthorization(serverId, redirectOrigin?)` | Start the attempt, or join the one already pending for the server; resolves with the attempt and the authorization page the user opens. The redirect origin defaults to the loopback form of the web listener's own origin; a supplied one must be a loopback HTTP(S) origin, or an HTTPS origin the connection's trust fence serves |
| `cancelAuthorization(serverId)` | Withdraw the pending attempt and wait until its callback route and protocol flow are released; an unknown or settled attempt is ignored |
| `signOut(serverId)` | Delete the stored grant through the connection; the connection then waits for a new authorization |

An attempt moves through `starting`, `waiting-browser`, `exchanging`, and `committing`, then settles as `authorized`, `cancelled`, or `failed`. Each authorization-server request is bounded by the entry's `requestTimeoutMs`, and the wait for the browser plus the token exchange by its `authorizationTimeoutMs`; discovery, registration, and the local credential commit sit outside that second budget; a failed attempt logs its safe reason, never a code, state, or token. The browser returns to the public exact route `/mcp/oauth/callback/<sha256 hex of the server id>`, registered on the web listener for the attempt's lifetime only. The authorization server's redirect is a cross-site navigation, which route admission would refuse, so the callback is a public route: it accepts only the redirect URI's own authority, requires a single-use `state` compared in constant time and bound to the pending attempt, and answers with a static bilingual page that echoes no request value. The PKCE code exchange and the grant record belong to [`dsh-mcp-client`](../mcp-client/README.md).

`status()` reports `authorization` (`authorized`, or `waiting-authorization` with its reason) and the latest `attempt` (id, phase, and deadline) for OAuth servers with a live connection. Only enabled entries can be authorized or signed out; a disabled entry keeps its stored grant and uses it once enabled.

## Plugin registrations

`ctx.mcpUserConfigRegistrations.register(serverName, entry)` contributes one MCP server for the calling plugin's lifetime: the entry carries every configured field except `id`/`enabled`/`serverName`, is validated like a configured entry, and shares the `serverName` namespace with Settings in both directions — a registration refuses a configured name and a settings write refuses a registered name. The registration is enabled while registered; its removal (the returned disposer, or the plugin fiber that owns the `ctx.effect` wrapping it) awaits the shared owner's teardown, so the server's tools withdraw before plugin disposal settles. Registered servers join the capability catalog read-only, mount scoped registrars in every profile on the live plane, and never appear as editable settings rows.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.mcpUserConfigSettings` | Read the captured generation snapshot, or current settings for a standalone consumer |
| `ctx.mcpUserConfigRegistrations` | Plugin-registration face over the host-owned fleet (provider scope) |
| `ctx.mcpConnections` | Shared-connection registry the owners create into and the registrars attach through |
| `ctx.capabilities` | Optional private generation capture and server selection integration |
| `ctx.tools` | Required by each registrar for model-facing tool registration |
| `ctx.webServer` | Optional: registers the OAuth callback route and supplies the default redirect origin (structural) |
| `ctx.connection` | Optional: judges a browser-supplied redirect origin against the deployment's trusted hosts and origins (structural) |
| `ctx.credentials` | Optional: the credentials seam OAuth grants are stored through and an OAuth probe reads (structural) |

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
- The management Remote reports state; the settings page re-joins on the forwarded `mcpManagement/fleet-changed` event (and keeps a 5 s poll as fallback) rather than subscribing to a wire stream — the typert protocol has no stream-mode Remotes.
- **Explicit authorization needs the web listener** — a headless composition answers `explicit MCP OAuth authorization requires the web listener`. The default redirect origin is the loopback form of the listener: a deployment reached over the LAN or by name must have that browser origin in the connection's `trustedHosts`, and an authorization server that refuses IP-literal or loopback redirect URIs cannot be used from such a deployment.
- **Disabled entries cannot be authorized** — enable an entry first; its stored grant survives being disabled.
- **An attempt against a replaced connection is cancelled** — a settings change or restart that remounts the owner while the browser is open settles the attempt as `cancelled`.
