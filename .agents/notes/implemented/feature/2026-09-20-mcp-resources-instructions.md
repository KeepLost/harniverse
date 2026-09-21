# Agent Note: MCP runtime — resources, server instructions, scoped visibility

Status: implemented

English | [中文](2026-09-20-mcp-resources-instructions.zh.md)

Scope: `packages/mcp`, `packages/core/system-prompt`, `packages/capability/capabilities`, `packages/preset/agent-presets`

## Problem

Blueprint W07 required the MCP runtime half: protocol negotiation with resource-capable servers, `resources/*` surfaces, server instructions reaching the system prompt, scoped server names, Profile member narrowing that holds for resources, generation-safe refresh, repeated-cursor protection, and model-visible snapshots of the resource surface. The first batch shipped the identity/visibility contract (`resource-contract.ts`) but no runtime: tools were the only bridged capability, and `syncTools` drained pagination without guarding against a server that repeats its own continuation cursor.

## Decision

- **A dedicated `mcpResources` seam** (`packages/mcp/mcp-resources`): scoped providers register per server (`NamedEntries` over `ScopedLayers`); the runtime owns the three shared tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) and a `mcp-resource-servers` prompt section listing the servers reachable from the caller's scope. Tools outlive providers — disposing one server withdraws its provider only. Requests route through the effective scope map; an unknown server fails loud.
- **Instructions captured at connect** (`mcp-client/src/connection.ts`): after a successful connect and discovery, initialize instructions retain their literal text, gain attribution (`### MCP server: <name>`), are budget-checked (`maxInstructionBytes`, default 32 KiB, attributed bytes), and appear through a verbatim prompt section; the give-up path clears them. A section is emitted only while non-empty.
- **`interpolate: false` on `PromptSection`** (`packages/core/system-prompt`): external text (instructions, server-name lists) keeps braces verbatim instead of failing strict interpolation; the flag rides `AssembledSection` and `renderPrompt` skips only flagged sections.
- **Atomic resource discovery**: resource-capable servers publish sorted concrete URI and template inventories together, after both paginated lists complete in the current connection. Failures retain the last good inventory. Resource list-change notifications, connect, tool re-sync, and reconnect refresh discovery. The SDK owns protocol negotiation, version rejection, and URI-template parsing; tools discovery requires a negotiated tools capability.
- **Complete-result bounds**: discovery permits 1,024 identities and 1 MiB across its pages. Each pagination drain permits 128 pages and rejects repeated cursors before dispatch, treating empty cursors as opaque values. Complete decoded resource results are limited to 1 MiB, including binary and metadata; model text is limited to 32 KiB including attribution and truncation notice. Rendering masks binary blobs, removes protocol metadata, and preserves UTF-8 character boundaries. SDK receive allocation occurs before these bounds.
- **Authorization before dispatch**: server visibility is evaluated using the Agent key directly. Instructions and server names use the same visibility decision. Concrete resources and URI templates have distinct stable member ids; listings are member-filtered and reads require a concrete grant or an SDK-matched allowed template. Effective explicit allowlists survive discovery and inherited global settings. A denied read sends no RPC.
- **Private generation captures**: `mcp-user-config` captures settings through a generic capability-adapter hook before Profile consumers mount. Public signatures contain only provider revision identities, never credentials. Settings replacements select a new standing generation; retained clients reconnect with their original configuration and grants. Excluded servers are omitted before child activation. Catalog discovery retries concurrent settings changes so signatures and captured clients agree.
- **Keyless verification scenarios**: the real SDK protocol test exercises supported and rejected versions plus resource-only startup. The Loader/Profile test uses shipped MCP rows and a real local SDK server to cover Minimal exclusion, template grants, settings replacement, and retained generations. Unit tests assert zero wire calls on denial and complete byte limits; these complement the existing request-header and tool-result Session logging contracts.

## Alternatives considered

- Keeping resources inside `mcp-client`: rejected — multiple servers each register one provider; the tools and prompt section must be shared, scoped, and disposed independently of any one connection.
- Treating expanded template URIs as concrete catalog entries: rejected because parameters form an open set; a distinct template member grants SDK-matched expansions instead.
- Instruction capture via the existing `tools/change` flow: rejected — instructions are per-connection state tied to connect/give-up lifecycle, not to tool-set changes.
- A per-request wrapper on `agent/request` for visibility: rejected — enforcement belongs on the resource surface the tools actually call, where unscoped callers and future consumers are covered too.

## Consequences

The host owns the shared resource service; Standard-family Profiles own captured clients and Minimal omits them. Tool-only allowlists exclude resources and templates; unrestricted servers admit resources without requiring every expanded URI in the catalog. List-change notifications refresh topology within the captured generation; settings and selection edits affect future assemblies. Resource-content subscriptions and server-defined prompts remain deferred. Superseded standing generations retain their processes until the owner disposes them, following the existing Profile lifecycle.
