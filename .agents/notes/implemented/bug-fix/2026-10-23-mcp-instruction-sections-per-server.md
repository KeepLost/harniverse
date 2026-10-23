# Agent Note: MCP instruction sections are per server, not per reservation key

Status: implemented

English | [中文](2026-10-23-mcp-instruction-sections-per-server.zh.md)

## Context

Startup logs reported, once per boot with two or more enabled MCP servers:

```
mcp-client-registrar Error: prompt section "mcp:mcp-user-config-1" is already registered in this scope
```

## Diagnosis

The `mcp-user-config` consumer mints **one** reservation key per profile
generation (`mcp-user-config-<n>`) and passes it to every registrar it mounts —
one per enabled server. `exposeScopedServer` derived the instruction-section
owner as `reservationKey ?? serverName`, so every server in the generation
collapsed onto the same section name `mcp:<key>` inside the profile scope. The
first registrar won the name; every later registrar's `systemPrompt.section()`
threw inside its `ctx.inject` callback. The rejection is contained by the
fiber machinery (the registrar's tools and resources still register — those are
separate effects), so the visible damage was the startup error line plus the
loss of attributed server instructions for every server after the first.

The reservation name itself (`<key>:<serverName>`, mcp-client
`registrar.ts` / `index.ts`) was already per-server; only the section owner
dropped the public name. Standalone instances were unaffected: without a
reservation key the owner is the `serverName`, and duplicates of that are
rejected by the root reservation before a section ever registers.

## Change

`packages/mcp/mcp-client/src/exposure.ts` — the instruction-section owner now
mirrors the reservation identity: `reservationKey === undefined ? serverName :
`${reservationKey}:${serverName}``. One reservation key serving several
servers now keeps one section per server. The `server-context.ts` owner JSDoc
and both package READMEs state the keyed section name.

## Verification

- RED→GREEN: `mcp-client/tests/server-context.spec.ts` mounts two
  `exposeScopedServer` calls under one shared reservation owner and asserts
  both instruction sections render and dispose independently; failed before
  the fix (`Notes instructions.` missing), passes after.
- RED→GREEN: `mcp-user-config/tests/generation-composition.spec.ts` boots the
  shipped MCP rows through the real Loader with two configured servers and
  asserts the Standard generation's assembled prompt carries both
  `### MCP server: <name>` attributions plus both servers' resource calls;
  failed before the fix, passes after.
- Full `mcp-client` + `mcp-user-config` suites: 222 passed.

## Alternatives considered

- Per-server reservation keys minted by the consumer: rejected — the key also
  namespaces the root reservation, and one owner identity per consumer keeps
  fleet accounting simple; the section name was the only collapsed derivation.
- Making `SystemPrompt.section` auto-suffix duplicates: rejected — silent
  shadowing would hide real collisions instead of failing at the narrow
  boundary that owns the identity.
