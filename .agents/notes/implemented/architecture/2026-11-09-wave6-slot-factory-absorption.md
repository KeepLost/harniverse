# Agent Note: Wave-6 slot machinery absorption (factories, standard sources)

Status: implemented

English | [中文](2026-11-09-wave6-slot-factory-absorption.zh.md)

## Problem

The Wave-6 rows that ride on upstream's slot re-platforming — Component Factories, the `hoc` slot kind, keyed standard hooks, and the conversation menu contributions still queued behind this batch — cannot be patched onto harniverse's slot core: upstream replaced the session-coupled provide plumbing (`SessionProvideInfo`, the renderer's special-cased `strictSessionAbsent` fallback) with a domain-neutral standard-source architecture (root sources + scope adapters + factory ledger), and harniverse's copies of the core, the React glue, and the runtime sessions service had drifted from all of it.

## Decision

Absorb the official slot machinery at pinned `fcc0ad4621`, mapped onto harniverse's packages (upstream's `ui-renderer` package does not exist here):

- **Core (`ui-slots`)**: the official index/renderer/store verbatim — `SlotFactoryMap` with the `'hoc'` kind, the `Factory*` type family, keyed standard sources, `ChainRenderOpts.fallbackOnly`, strict `slot`/`factory` snapshot nodes, and the factory single-definition ledger (`registerFactory`, `subscribeFactory`).
- **Registry (`runtime/src/client/slots.ts`)**: the official `registry.ts` plus harniverse's seams kept and documented in code — the `machineKey` persistence namespace (`host`/`remote:<id>`) applied through `storeScopeKey` prefixing in `resolveStore`/`resolveFactoryStore`, `pruneStoreScope` extended to the factory axes, and `resetTarget`. The host face is domain-neutral: root / scopeRevision / scope / factory channels; sessions and workspaces ride `provideRoot({ hooks, keyedHooks })`, the session scope installs `sessions.scopeAdapter` through `installScope('session', …)`. The runtime apply now constructs `new SlotRegistry(ctx)` directly — the old `ctx.plugin(SlotRegistry)` construction left same-tick `ctx.get('slots')` lookups undefined, and the old `ctx.get('slots')?.resetTarget()` calls were silent no-ops (a latent machine-switch bug, now fail-loud).
- **Sessions (`runtime/src/client/sessions/`)**: `SessionProvideChannel` materializes `StandardSourceBinding`/`ScopedStandardSourceBinding` values (builtin descriptor: the `session` hook, the `projection` keyed hook, the `sessionId` prop); the service face renames to `currentScopeBinding`/`provideBinding`/`maybeBinding` and exposes the `SlotScopeAdapter`.
- **React glue (`web-react`)**: the official `scoped-slots.tsx`/`bindings.tsx`/`errors.tsx`; `session-provider.tsx` is deleted (SessionProvider is now the scope area — plain `children`, not a render prop). Strict session slots render only inside an area and throw otherwise; an adapter without `renderArea` falls back to the generic `defaultScopeArea` (the runtime stays React-free). `bind.ts`, `use-invoke.ts`, and the uSES adapter stay harniverse's.
- **Consumers**: `ConversationRoot`/`InputBar` gate strict-session child seats on `sessionId !== undefined` (upstream `ConversationContent`/`InputBar`'s shape) and the absent-session composer rides `fallbackOnly`; the runner's live composition inspection ports the factory node branch; `test-support`'s fake host learns the factory members and binding-shaped sessions double.
- **Catalog**: `cordis-client-runner`'s API catalog gains the 21 factory/standard-source type entries plus the `registerFactory` method and the `slots/changed`/`subscribeFactory` split; the slot-catalog's factory families arrive with the conversation contributions (batch D stage 5), not here.

`SlotScopeTargetMap` stays declared empty: an explicit Provider `session={…}` target resolves absent, and the session scope follows the current selection — harniverse's adoption machinery depends on that, so upstream's explicit-target tests are adapted rather than ported. That divergence (and the machine namespace) is the documented seam; upstream's `ui-session` package is not absorbed.

## Alternatives considered

**Keep harniverse's provide plumbing and add only `registerFactory`.** The factory ledger, scoped sources, and the strict/absent render rules are one architecture upstream; a partial port would leave two binding vocabularies in the renderer and no path for the `hoc` kind or the queued conversation contributions.

**Absorb upstream's `ui-renderer` package as a new package.** Harniverse's registry lives in `runtime` and the React glue in `web-react` (one registry, one renderer, machine-aware store scoping); re-homing them would break the loader externals and the plugin contract for no architectural gain.

**Adopt `SlotScopeTargetMap` now.** No consumer declares a target; adoption follows the current selection by design. Deferred with the bindingSource-always-absent seam until upstream's `ui-session` absorption.

## Consequences

SessionProvider's children contract changes from a render prop to plain `ReactNode` (components rendering strict-session children must wrap them in an area — `ConversationRoot` does; the resident composer seat stays outside by design). Specs that mounted a bare `SlotRegistry` must wire `provideRoot`/`installScope` or strict session-maybe slots throw; fake-host benches use stable singleton root/adapter sources or uSES loops. Store identity is now `(machineKey, scope)`-namespaced on both ordinary and factory axes, so a dead session's persisted state clears through `pruneStoreScope` and a machine switch drops non-root instances through `resetTarget` — previously only ordinary stores were covered. The upstream notes ([Component Factories and Local Slots], [Slot type chain]) remain the canonical design records; the machine-namespace and selection-scope seams are documented in the three package READMEs and the module docs.

[Component Factories and Local Slots]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md
[Slot type chain]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md
