# Agent Note: Web file and session references

Status: implemented

English | [中文](2026-08-24-web-file-and-session-references.zh.md)

## Problem

The Web composer needs one `@` completion surface for workspace paths and prior sessions, but Harniverse Remote routes require explicit capability metadata and its session-reference service already owns snapshot safety and delivery semantics. File selection must remain a user-authored path rather than an implicit read or attachment, while session selection must preserve opaque identity and the existing untrusted snapshot boundary.

## Decision

`@deepseek-ai/dsh-file-reference` defines the path-only candidate contract, grammar, prompt text, and authenticated `fileReferences/list` Remote with `harniverse.observe`. `@deepseek-ai/dsh-file-reference-local` provides bounded per-Agent workspace search: it excludes `.git` and `node_modules`, does not traverse directory symlinks, rejects path escape, follows caller cancellation, and invalidates its index after `tool/result`.

`@deepseek-ai/dsh-client-ui-reference` registers one browser `@` source. It requests file and session candidates concurrently, renders files before sessions with section headings, keeps quoted directory queries in the file domain, and treats each domain failure as an empty result. File picks insert ordinary `@path` text and directory picks continue completion. Session picks retain the service-provided canonical `@[label](dsh-session:...)` mention as the atomic reference value; titles never reconstruct identity.

The local Provider adds the stable read-before-claiming-inspection guidance only when the effective Agent tool registry exposes `read`. The session-reference service exposes authenticated metadata-only candidates and prepares canonical mentions in its prepended `agent/pre-step` listener, placing the frozen untrusted snapshot context before the readable direct message. The Web bundle composes these packages explicitly, while the fixture Remote face serves deterministic file and session metadata over the same connection contract.

## Alternatives considered

**Copy the official UI and transport packages unchanged** — rejected because Harniverse owns fixed Web startup, slot composition, Remote authentication metadata, and the existing placeholder/reference transaction model. The adaptation keeps only the required contracts and composes through Harniverse's existing faces.

**Read or attach a selected file immediately** — rejected because completion is discovery only. The path remains ordinary prompt text, and the model must call the effective `read` tool before claiming inspection.

**Rebuild session identity from a displayed title** — rejected because titles are metadata and can be absent, duplicated, or changed. The canonical URI supplied by the Host remains the identity carried through selection and submission.

**Add the capability to every default composition** — rejected because the existing Web composition is the owner of this browser behavior. Other profiles remain unchanged unless they explicitly mount the provider and client plugin.

## Consequences

Path discovery has a bounded local cost and a disposable per-Agent cache, while direct directory completion observes current entries without following symlinks. A mounted local Provider adds one cacheable prompt section only for Agents that can actually call `read`; candidate labels and file contents do not become model context.

Session references remain metadata-only until the agent pre-step reads and freezes their source snapshots. The durable context retains the existing untrusted warning, projection, retention budgets, and source ordering. The Remote boundary is denied without `harniverse.observe`, and fixture calls exercise the same endpoint names and canonical wire values as the client.

## Testing

Focused tests cover grammar, traversal, excluded directories, symlink and cwd isolation, cancellation, cache invalidation, conditional read guidance, canonical session serialization, pre-step ordering, independent file/session failure, quoted tokens, directory continuation, fixture Remote routing, and the Web patch's composed host/browser rows. Host and client Remote typechecks pass; generated Cordis and config catalogs are fresh. Full Web/build verification remains limited by unrelated baseline type and documentation failures outside this feature.
