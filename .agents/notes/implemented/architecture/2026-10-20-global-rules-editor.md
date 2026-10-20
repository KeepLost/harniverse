# Agent Note: First-party global rules editor over the apiproxy wire

Status: implemented

English | [中文](2026-10-20-global-rules-editor.zh.md)

## Problem

The harness home's `AGENTS.md` — the `user-global` instruction scope every session loads — had no first-party editing surface: editing meant a shell and a text editor, and the community plugin `dsh-global-rules` (upstream DSH, third-party) demonstrates the demand but rides a plugin-compatibility fetch surface Harniverse does not ship, mirrors only the `$DSH_HOME` precedence leg of home resolution (drift risk against the loader's config-over-env precedence), and carries its own hand-rolled UI outside the first-party settings contracts. Harniverse wanted the capability as a first-class capability seam: Service Definition, Provider, and Consumer roles over its own wire, settings, and locale contracts.

## Decision

Three pieces along the standard seams:

- **Service Definition + Provider** — `packages/context/global-rules` default-exports `GlobalRulesService extends Service` (`ctx.globalRules`). Home resolution reuses `resolveDshHome(config.dshHome)` (identical precedence to the loader: config over `$DSH_HOME` over `~/.dsh`), the write cap defaults to the loader's per-file source cap (1 MiB) so the editor accepts exactly what the loader reads, and the display path is symbolic through `dshHomeDisplay` — absolute paths never leave the host. The freshness token is a sha256 prefix of the content itself, so the conflict check compares content identity, not write history, and a successful write needs no post-write stat.
- **Wire** — two unary endpoints on the shared `/api` carrier, `globalRules.read` (`harniverse.observe`) and `globalRules.write` (`harniverse.operate`: the file steers every session's model-visible baseline), following the `speech.*` precedent end to end: contract + zod schemas in `apiproxy/src/api/`, three `rpc-map.ts` registries, `fetch/handler.ts` dispatch, `IApiClient` + value schemas in `fetch/client.ts`, the `ApiProxy.globalRules` adapter mapping service outcomes onto stable error codes (`global-rules-unavailable` / `-conflict` / `-too-large` / `-read-failed` / `-write-failed`), the connection fixture dispatch, and regenerated `docs/api-catalog.json`. No new transport, no plugin fetch registry, no settings namespace — the file is the durable state, so a settings-namespace mirror would be a second source of truth.
- **Consumer** — `packages/client/ui-settings-global-rules` registers the `settings.section` entry (id `global-rules`, order 12) and its `settings.nav.icon` glyph over the standard four-shares props. The section byte-accounts against the host-reported cap (multibyte-safe via TextEncoder), saves only dirty drafts while echoing the loaded token, reports the loader's effect semantics after a save, and offers explicit reload on conflict. Effect propagation is owned entirely by `dsh-agent-instructions`' existing reconcile — new sessions on first step, live sessions after their next file operation — so this feature adds no propagation of its own.

Composition: the host row and browser roster row live in the `dsh-web-app` bundle (the settings surface exists on web and desktop; headless/TUI never mount it, and the endpoint's optional seam answers `global-rules-unavailable` there).

## Verification

- `packages/context/global-rules` — 10 tests over real temp homes: absence, round-trip with token shape, home creation, matching/stale/disappeared version echos, multibyte cap refusal, configured-over-env-over-default resolution, non-absence failure propagation; per-file 100% coverage.
- `packages/host/apiproxy/tests/api-proxy-global-rules-rpc.spec.ts` — 6 tests pin the proxy-level mapping: both views, seam absence, conflict with token details, cap with `maxBytes` details, and read/write failures under their codes.
- `packages/client/ui-settings-global-rules` — 26 tests: registration/HMR disposal (section + glyph + inject face), dictionary parity, and the section's presentation behavior (load states, byte counter units, dirty/save/revert, version-echo contract, conflict + reload, over-cap guard, localized seam absence, refused/thrown/non-Error failures); per-file 100% coverage.
- `docs/api-catalog.json` regenerated via `gen-api-catalog`; `module-graph` regenerated and mirrored; `verify-translation-pairing` green (1240 pairs).
- The settings Chrome e2e exercises the section against a real composed host and refreshes the settings-dialog golden.

## Alternatives considered

**Adopt the third-party plugin as-is.** Zero implementation cost, but it targets the upstream `ctx.connection.fetch.register` surface Harniverse does not ship, env-only home resolution (the loader's `dshHome` config override would desync the editor from the file actually loaded), and a hand-written bundle outside the four-shares/locale/token contracts. Rejected; the plugin remains installable as an external plugin for stock runtimes.

**Expose the editor as a settings namespace.** The settings machinery already namespaces browser preferences, but the rules file is the durable source the loader reads; a namespace would mirror file bytes into the settings document and the two would drift on every external edit. Rejected as a second source of truth.

**Serve through a dedicated Connection RPC channel.** A channel per feature multiplies trust surfaces for zero benefit over the shared `/api` carrier's existing fence + capability gate; the `speech.*` unary precedent already answers this shape. Rejected.

## Consequences

- `IApiClient.globalRules` joins the required client face: the connection/runtime test doubles gained a stub (one member, two files) — the same cost every new unary domain pays.
- Conflict detection is best-effort optimistic locking, not a transaction: two racing writers can both pass the token check; documented in the service README as a known limitation with rename-based swap as the upgrade path.
- The write cap and the loader's `maxSourceBytes` are two configs that must move together; both default to 1 MiB and the composition row comment says so, but nothing mechanically couples them yet.
- Every web/desktop composition now carries `dsh-global-rules` (stateless file adapter, no lifecycle); compositions that never want the editor can disable the row and the endpoints degrade to `global-rules-unavailable`.
