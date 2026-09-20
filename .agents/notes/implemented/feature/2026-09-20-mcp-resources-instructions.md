# Agent Note: MCP runtime — resources, server instructions, scoped visibility

Status: implemented

English | [中文](2026-09-20-mcp-resources-instructions.zh.md)

Scope: `packages/mcp/mcp-resources`, `packages/mcp/mcp-client`, `packages/core/system-prompt`

## Problem

Blueprint W07 required the MCP runtime half: protocol negotiation with resource-capable servers, `resources/*` surfaces, server instructions reaching the system prompt, scoped server names, Profile member narrowing that holds for resources, generation-safe refresh, repeated-cursor protection, and model-visible snapshots of the resource surface. The first batch shipped the identity/visibility contract (`resource-contract.ts`) but no runtime: tools were the only bridged capability, and `syncTools` drained pagination without guarding against a server that repeats its own continuation cursor.

## Decision

- **A dedicated `mcpResources` seam** (`packages/mcp/mcp-resources`): scoped providers register per server (`NamedEntries` over `ScopedLayers`); the runtime owns the three shared tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) and a `mcp-resource-servers` prompt section listing the servers reachable from the caller's scope. Tools outlive providers — disposing one server withdraws its provider only. Requests route through the effective scope map; an unknown server fails loud.
- **Instructions captured at connect** (`mcp-client/src/connection.ts`): after a successful connect + tool sync, the initialize instructions are trimmed, attributed (`### MCP server: <name>`), budget-checked (`maxInstructionBytes`, default 32 KiB, attributed bytes), and exposed through a verbatim prompt section; the give-up path clears them. A section is emitted only while non-empty.
- **`interpolate: false` on `PromptSection`** (`packages/core/system-prompt`): external text (instructions, server-name lists) keeps braces verbatim instead of failing strict interpolation; the flag rides `AssembledSection` and `renderPrompt` skips only flagged sections.
- **Resource discovery with contained failure**: when `getServerCapabilities().resources` is advertised, the connection drains paginated `resources/list` into a sorted URI cache (cursor-guarded); discovery failures log and keep the previous cache. Cached URIs feed capability snapshot members (`mcp-resource` kind) and the names+URIs change comparison that triggers generation refresh — resource discovery is therefore generation-safe exactly like tool sync.
- **Repeated-cursor protection everywhere pagination drains** (`cursorGuard` in `tools.ts`): a server returning a cursor it already returned fails the attempt as invalid pagination, for both tools and resources.
- **Visibility enforced at the wire, not the catalog**: `restrict()` records per-scope resource visibility next to tool restrictions; the provider wrapper registered into `mcpResources` resolves the nearest record along the caller's scope chain and enforces it — `resources/read` of an invisible URI throws, `resources/list` results are filtered to visible URIs, templates pass through unfiltered (no stable identity to filter by). Unscoped compositions are unrestricted; an unloaded server denies everything.
- **Keyless real-composition evidence** instead of a recorded snapshot: `resources.spec.ts` boots a real stdio MCP fixture server (instructions with literal braces, text + binary + config resources, a template) and asserts the model-visible surfaces end-to-end; the recorded snapshot harness needs a provider key, which the fixture-server path deliberately avoids.

## Alternatives considered

- Keeping resources inside `mcp-client`: rejected — multiple servers each register one provider; the tools and prompt section must be shared, scoped, and disposed independently of any one connection.
- Filtering template listings by visibility too: rejected — template URIs have no member identity in the capability contract; filtering would either invent one or mislead.
- Instruction capture via the existing `tools/change` flow: rejected — instructions are per-connection state tied to connect/give-up lifecycle, not to tool-set changes.
- A per-request wrapper on `agent/request` for visibility: rejected — enforcement belongs on the resource surface the tools actually call, where unscoped callers and future consumers are covered too.

## Consequences

`mcp-client` gains optional `mcpResources`/`systemPrompt` integrations that activate when composed; without them the bridge behaves exactly as before. The capability descriptor now includes resource members, so Profile allowlists written against tool members alone keep working (tool ids unchanged) while new resource members default visible until narrowed. Subscriptions (`resources/listChanged`) are not bridged — the cache refreshes on connect, re-sync, and reconnect; documented as a Known Limitation. The pagination guard turns a previously infinite drain into a contained attempt failure.
