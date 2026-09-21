# @deepseek-ai/dsh-mcp-resources

English | [中文](README.zh.md)

Scoped MCP resource seam: a `ctx.mcpResources` registry where each MCP server connection registers a resource provider, plus the three model-facing tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) and a system-prompt section that names the servers reachable from the current agent's scope.

Providers are registered per scope. An agent only sees the servers whose `mcp-client` instances are visible in its scope chain; a server mounted in a sibling scope is unreachable and its name never reaches the prompt. The three tools outlive individual providers — disposing one server withdraws its provider while the tools stay registered for the remaining servers.

## Usage

The host composes `mcp-resources` once; scoped `mcp-client` instances then register their providers. A custom provider implements the interface and registers on a scoped context:

```ts ignore-check
ctx.mcpResources.register('my-server', {
  async request(request, exec) {
    // request: { method: 'resources/list', cursor? }
    //        | { method: 'resources/templates/list', cursor? }
    //        | { method: 'resources/read', uri }
    return { resources: [{ uri: 'docs://guide', name: 'Guide', mimeType: 'text/plain' }] }
  },
})
```

Requests are routed with the Agent's scope key. An optional registration `visible(scopeKey)` predicate filters both the server-name prompt and execution before provider dispatch. An unknown or excluded server throws `MCP resource server "<name>" is unavailable in this agent's scope`.

## Model-visible surfaces

- The prompt section `mcp-resource-servers` (verbatim — braces in server text are never interpolated) lists the sorted reachable server names and instructs the model to use them as the `server` argument.
- `list_mcp_resources(server, cursor?)` — list resources available from a server.
- `list_mcp_resource_templates(server, cursor?)` — list parameterized resource URI templates.
- `read_mcp_resource(server, uri)` — read one resource by URI.

Results render as one JSON text block attributed to the server: `MCP server: <name>\n<json>`. Binary payloads (`blob` string fields) become `[binary resource: N base64 characters; available to programmatic callers]`; `_meta` fields are omitted from model text. Complete canonical results exceeding 1 MiB are rejected. Rendered text is bounded to 32 KiB of UTF-8 including attribution and any truncation notice, without splitting a character. Accepted canonical results retain the original bytes for programmatic callers.

## Config

None — the plugin takes no configuration.

## Services

| Service | Usage |
|---|---|
| `ctx.tools` | Register the three resource tools for the lifetime of the plugin |
| `ctx.systemPrompt` | Register the `mcp-resource-servers` section (verbatim) |

Provided: `ctx.mcpResources` — `register(serverName, provider, { visible? }?): () => void`, scoped per plugin fiber.

## Model Experience

### Resource tools and server list

#### What the model sees

Three fixed tool schemas (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) plus one prompt section naming the reachable servers. Listing and reading return compact JSON; text resources arrive as their contents, binary resources as a masked placeholder.

#### Token effect

The three schemas are a fixed cost while providers exist in the caller's scope chain. With no providers, including the shipped Minimal Profile, neither tools nor the server section are contributed. The section lists only reachable servers. Results enter history once as bounded rendered text.

#### KV Cache effect

Prefix-stable while the reachable server set is unchanged. A server entering or leaving scope rewrites the section and may invalidate reuse from its first changed token; read results are append-only.

## Known Limitations and Deferred Work

- **Provider-owned member authorization** — `mcp-client` filters resource and template members and checks reads before network dispatch. Custom providers must implement their own member permissions; the registry enforces server visibility.
- **No resource-content subscriptions** — the client observes list-change notifications but does not subscribe to individual resources.
- **Reads are bounded by the owning server's timeout** — the request rides the connection's `toolCallTimeoutMs`.
- **Scoped resolution follows agent scope only** — a provider registered on an unscoped context is visible everywhere; narrowing requires composition through a scoped plugin. Two servers sharing one public name must publish from separate scopes — the provider registry routes by public name, so a same-scope duplicate is a configuration error.
