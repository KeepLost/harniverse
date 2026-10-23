# Agent Note: MCP instruction sections are per server, not per reservation key

Status: implemented

English | [中文](2026-10-23-mcp-instruction-sections-per-server.zh.md)

## Problem

With two or more enabled MCP servers, every boot logged `mcp-client-registrar Error: prompt section "mcp:mcp-user-config-1" is already registered in this scope`, and every server after the first lost its attributed instructions in each profile composition. The `mcp-user-config` consumer mints one reservation key per profile generation (`mcp-user-config-<n>`) and passes it to every registrar it mounts — one per enabled server — while `exposeScopedServer` derived the instruction-section owner as `reservationKey ?? serverName`, so all servers in a generation collapsed onto the same section name `mcp:<key>` inside the profile scope. The first registrar won the name; every later registrar's `systemPrompt.section()` threw inside its `ctx.inject` callback, whose rejection cordis contains, so the registrar's tools and resources (separate effects) still registered and only the error line plus the missing instructions were visible.

## Decision

The instruction-section owner in `packages/mcp/mcp-client/src/exposure.ts` now mirrors the root reservation identity: `reservationKey === undefined ? serverName : `${reservationKey}:${serverName}``. One reservation key serving several servers keeps one section per server; standalone instances are unchanged (the bare public name, whose duplicates the root reservation already rejects before any section registers). The `server-context.ts` owner JSDoc and both package READMEs state the keyed section name.

## Alternatives considered

**Per-server reservation keys minted by the consumer.** Rejected because the key also namespaces the root reservation and one owner identity per consumer keeps fleet accounting simple; the collapsed section name was the only faulty derivation.

**Auto-suffixing duplicate names in `SystemPrompt.section`.** Rejected because silent shadowing would hide real collisions instead of failing at the narrow boundary that owns the identity.

## Consequences

- A profile generation with N enabled servers now carries N distinct instruction sections (`mcp:<key>:<serverName>`), so the startup error and the silent instruction loss are gone.
- Section names become longer under reservation keys; nothing consumes the `mcp:` prefix beyond ordering, which is unaffected.
- Standalone exposure keeps the documented `mcp:<serverName>` name and its existing duplicate semantics.

## Testing

`packages/mcp/mcp-client/tests/server-context.spec.ts` mounts two `exposeScopedServer` calls under one shared reservation owner and asserts both instruction sections render and dispose independently; it failed before the fix (`Notes instructions.` missing). `packages/mcp/mcp-user-config/tests/generation-composition.spec.ts` boots the shipped MCP rows through the real Loader with two configured servers and asserts the Standard generation's assembled prompt carries both `### MCP server: <name>` attributions plus both servers' resource calls; it failed before the fix. The full `mcp-client` and `mcp-user-config` suites pass (222 tests).
