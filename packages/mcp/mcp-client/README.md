# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`). When `dsh-mcp-resources` is composed, each connection also publishes its resources on `ctx.mcpResources`, exposes the server's instructions as a prompt section, and contributes resource members to the capability descriptor.

When `ctx.capabilities` is composed, the instance also registers one effect-owned `mcp-server` descriptor with one immutable member per currently discovered public tool, resource URI, or URI template. Command arguments, environment, headers, credentials, and arbitrary server metadata remain private. A Profile may unload the server or retain an explicit member allowlist; refreshed generations apply the same policy to subsequently discovered tools and resources without disconnecting the Host-shared server process. A Profile-owned MCP row can instead be physically selected by the Profile recipe compiler.

The package also owns the MCP identity, visibility, and refresh contract: `MCP_SERVER_NAME_PATTERN`/`isMcpServerName` (the reserved server namespace), `McpResourceIdentity`/`isMcpResourceIdentity` and `mcpServerCapabilityId`/`mcpResourceMemberId`/`mcpResourceTemplateMemberId` (stable capability ids for servers, resources, and templates), `resolveMcpMemberVisibility` (the pure rule a narrowed Profile applies — an unselected server denies every member; an explicit member allowlist admits exactly the members marked visible), and `classifyMcpRefresh` (reconnect and tool/resource sync stay `'topology'` refreshes inside a running Session's captured capability generation; only Profile member or selection edits are `'composition'` changes that produce a new generation for future assemblies). Visibility is enforced at the wire: `resources/read` of a non-visible URI throws before dispatch, and both `resources/list` and `resources/templates/list` are filtered to visible members. URI-template reads use the SDK matcher.

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique across live instances |
| `reservationKey` | both | no | Internal owner key for consumers that project the same public namespace into separate scoped registries |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |
| `maxInstructionBytes` | both | no | Byte budget for the server's captured instructions, attributed header included (default 32768) |
| `failOnStartupError` | both | no | Reject plugin activation when initial connection or tool synchronization fails (default `false`) |
| `reconnect.enabled` | both | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | both | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive failed attempts per outage before giving up for good (default 10) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` across direct live instances fails the later plugin instance at load. An embedding consumer may supply distinct `reservationKey` values when separate scoped registries intentionally expose the same public namespace.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Behavior

- On connect: plugin activation awaits `listTools()` and registers each tool via `ctx.tools.register()` under its public name before the composition starts its first turn. Initial connection, discovery, or registration failure is always logged; it rejects activation when `failOnStartupError` is true and otherwise activates with no tools.
- Listens for `notifications/tools/list_changed` → re-syncs; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and leaves no tools from that server.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support—the public name is never sent to the server.
- Server instructions: after a successful connect and discovery, the server's initialize instructions are captured literally, attributed (`### MCP server: <serverName>`), then exposed as a verbatim `mcp:<serverName>` prompt section through the server-context registration. Payloads larger than `maxInstructionBytes` fail the attempt like any other synchronization error; giving up on reconnection clears the section.
- Resource discovery: when the server advertises the resources capability, the connection drains paginated `resources/list` and `resources/templates/list` into sorted caches after each sync; both inventories publish atomically and a discovery failure is contained (logged, previous caches kept). The cached URIs and templates feed the capability snapshot and change detection that refreshes the running topology.
- Pagination guard: every continuation-cursor drain (tools, resources, and templates) rejects malformed cursors, repeated cursors, and more than 128 pages before the next request instead of looping; empty cursors remain opaque.
- Resource requests: `resources.request` routes `resources/list`, `resources/templates/list`, and `resources/read` over the live connection (connected guard, `toolCallTimeoutMs` timeout, abort-aware) and returns the raw JSON value; the `mcp-resources` tools render it. Profile member visibility is enforced on this surface (see above).
- Canonical success is `{ content: JsonValue[], structuredContent? }`; complete JSON MCP blocks survive for programmatic callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`.
- Native/model rendering keeps the existing text projection: text blocks join with newlines while image, audio, resource, and unsupported blocks become placeholders.
- On disconnect/crash: the supervisor restarts the original server config with exponential backoff (`reconnect.initialDelayMs` doubling up to `reconnect.maxDelayMs`) and re-runs discovery on success — the recovered generation replaces the previous one, so tools neither duplicate nor leak. During the outage the last good generation stays registered; calls against it fail until recovery.
- Reconnection is budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered and reconnection stops until an HMR reload or Host restart. A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one — even with briefly successful connects — still exhausts the cap instead of restarting forever.
- Reconnect states are user-visible in logs: reconnecting (warn, with attempt count and delay), recovered (info), final failure and disabled-loss (error). Disposal cancels any pending reconnect. With `reconnect.enabled: false`, a lost connection keeps tools registered but failing until a reload — the manual-recovery behavior.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools |
| `ctx.capabilities` | Optionally publish server identity and apply Profile-generation selection |
| `ctx.mcpResources` | Optionally publish the server's resource provider (via `dsh-mcp-resources`) |
| `ctx.systemPrompt` | Optionally register the attributed server-instructions section |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. Text result blocks are joined with newlines into one retained Native text result; image, audio, resource, and unsupported blocks become short placeholders there. Their full JSON blocks and optional structured content remain in the execution-local canonical value, and MCP `isError` rejects the call through the registry's error path.

#### Token effect

Arguments and mapped text are retained until compaction. Binary and resource payloads are discarded rather than added to context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Server instructions and resource members

#### What the model sees

A selected server that sends initialize instructions contributes one verbatim `### MCP server: <serverName>` block. Braces are never interpolated. Concrete resource URIs and URI templates have distinct capability member ids and follow captured Profile allowlists, including inherited global grants. Template reads use the SDK's URI-template matcher. Server and read authorization run before network dispatch; resource and template lists are filtered. Excluded servers contribute neither names nor instructions to that Agent's prompt.

#### Token effect

The instructions block is bounded by `maxInstructionBytes` (32 KiB by default); the last successful snapshot remains during reconnect backoff and is removed on disposal or exhausted retries. Discovery retains at most 1,024 resource/template identities and 1 MiB of aggregate page data. Each pagination drain admits at most 128 pages and rejects repeated cursors before another request; empty cursors remain opaque values. Complete decoded resource results are limited to 1 MiB, and the shared tools render at most 32 KiB including attribution and truncation notice. Binary payloads and protocol metadata do not enter model text.

#### KV Cache effect

Prefix-stable while instructions and the visible member set are unchanged. A reconnect that recovers identical instructions reproduces the same section; a Profile member edit is a composition change that rewrites the descriptor for future assemblies.

## Known Limitations and Deferred Work

- **MCP Prompts are not bridged** — Tools and Resources are; server-defined prompts (slash-command-style) have no harness consumer and are deferred.
- **No resource-content subscriptions** — `notifications/resources/list_changed` refreshes URI and template discovery; `resources/subscribe` and per-resource content notifications are not bridged. Discovery publishes both inventories atomically and retains the last good inventory on failure.
- **SDK-owned decoding** — result bounds apply after the transport decodes JSON. They bound retained and rendered results, not the SDK's transient receive allocation. Protocol negotiation and unsupported-version rejection remain SDK-owned; a resource-only server needs no tools capability.
- **Startup timeout is inherited from the MCP SDK** — DSH does not yet expose a connection/discovery timeout. Each initialize or paginated `tools/list` request uses the SDK's 60-second default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request and through the SDK transport's own SSE-stream recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Native non-text rendering is lossy** — image, audio, and resource payloads become placeholders in model context even though the execution-local canonical value preserves their JSON blocks. Richer Native multimedia projection is deferred.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
