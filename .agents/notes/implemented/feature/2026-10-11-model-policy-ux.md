# Agent Note: Structured Model Policy settings and the new-session profile chip

Status: implemented

English | [中文](2026-10-11-model-policy-ux.zh.md)

## Problem

The Model Policy settings page was two raw JSON textareas over the `model-profiles` and `model-routes` settings sections. Users had to know provider route ids, model ids, effort ids, and route ids by hand, save-time validation only checked shape, and a bad default Profile or a dangling Route reference surfaced later as an `internal` error on every new session. The composer's model menu showed route ids instead of names, a Profile model entry without a reasoning effort was rejected by `session.selectModel` even though the filtered catalog offered the model (the guard compared efforts exactly after the host filled a default), and there was no way to choose a Profile for a session about to start.

## Decision

**One settings document.** The two sections merged into a single `model-policy` namespace holding `defaultProfile`, `profiles`, and `routes`, so every cross-reference validates at save time and saves atomically: a Profile may not reference an unknown Route, its default target must sit inside its own allowances (model or Route), the default Profile must exist, names and provider/model/effort strings may not be empty, and the reserved `unrestricted` id cannot be redefined. The same predicate runs on the composition entry in the constructor, so a miscomposed deployment fails at its earliest resolvable point, and on every stored write through the settings `validate` hook. `remote-runtime` sync and the apiproxy exposure allowlist moved to the one namespace. The pre-merge namespaces carried no stored data in this deployment, so nothing needed migration; an invalid stored document now fails the section registration at boot by design.

**Effort entries are wildcards unless they name one.** `allowsTarget` now admits any effort of a model whose Profile entry names no effort, matching `allowsConcrete` and the catalog filter; an entry with an explicit effort still restricts to it.

**Structured editors replace the JSON textareas.** The policy page (nav renamed 模型方案/Model Profiles, sharing the Models glyph) renders two card lists over one `ModelPolicyStore`: fallback chains (备用链) are ordered target rows picked from the live `llm.models` catalog with optional per-target effort restriction, up/down reorder, and off-catalog entries kept editable behind a badge; profiles (方案) are per-model allowances with optional effort restriction, chain checkboxes, one default target, and a header-level default-profile select. One editor is open at a time; each save replaces the whole user document behind the revision it opened against, so concurrent edits surface as `settings-conflict`. A chain referenced by any Profile refuses deletion, and base-layer entries render locked. Editing a Profile normalizes duplicate model allowances to one entry per model. The page keeps no JSON escape hatch — every field is representable in the structured editors.

**A session-less roster and the hero chip.** The new `llm.modelProfiles` RPC (capability `harniverse.observe`) serves the Profile descriptors plus the default id. `conversation.hero.modelProfile` — a new root-scoped slot in ui-conversation, occupied by ui-model-selection — renders beside the agent-preset chip on the new-session screen, hidden while only `unrestricted` exists. Unlike the preset chip, a pick applies live to the current blank session through `session.selectModelProfile` (a Model Profile is mutable per session); when no session is current the pick stages and calls `workspaces.startSession(undefined, undefined, modelProfile)`, which the runtime threads through `connectWorkspace` into `session.create`'s existing `modelProfile` field, and a reconciliation pass switches a reused blank session that was born under a different Profile. The composer's route row now shows the Route name, and both model surfaces renamed Profile/Route to 模型方案/备用链.

## Alternatives considered

- **Keep two namespaces with cross-validation.** Registering Routes before Profiles lets Profile validation read the Routes source, but a Routes-side delete can still dangle Profile references that only fail at the next boot, and the two-section writes could not be atomic. The pre-release stance (no stored data, no compatibility commitment) made the single-document merge the correct foundation instead.
- **Create-time profile selection only.** Threading the staged Profile into every session-creation flow would have matched the agent-preset chip exactly, but it mints a new blank session per changed mind and races the first message on flows that create lazily. Applying live to the current blank session keeps the wire's existing `modelProfile` create field for programmatic callers while avoiding both.
- **Keep a JSON escape hatch under an "advanced" disclosure.** Every field of the document is representable in the structured editors, so a second editing path would only fork validation and copy; the raw document remains readable in `settings.yaml`.

## Consequences

- Writers of the policy document through the raw settings API now meet the same validation as the UI; remote-runtime snapshots that drop a referenced Route are rejected until the Profiles side lands first in the same call.
- A Profile editor save normalizes duplicate model allowances and materializes base-layer entries into the user layer (arrays replace wholesale in the settings merge); deployments shipping base-layer policies should treat the first user edit as the copy point.
- The hero chip reads the current session's Profile per current-session change (`session.models`) because session summaries do not carry it; if that ever becomes a summary field, the chip's extra read can drop.

## Verification

- `packages/core/model-policy`: 37 tests including save-time rejection of every invalid invariant, the wildcard-effort regression, and composition-entry rejection at load; 100% line/branch coverage.
- `packages/client/ui-settings-models`: the policy section, store, and both editors are covered by 20+ component tests (creation, reordering, off-catalog entries, conflicts, principal moves, delete locks); the package holds 100% line/branch coverage.
- `packages/client/ui-model-selection`: the hero seat controller and chip are covered by 23 tests (staging, live apply, reconciliation, superseded settlements, RPC unavailability); the package holds 100% line/branch coverage on the new files.
- `apps/web/tests/models-policy.e2e.ts`: a keyless browser scenario that registers a reference-free provider, builds a chain from the live catalog, creates a Profile, records the default choice, and exercises the hero chip end to end, with three goldens; the settings-dialog nav rename refreshed eleven goldens.

## Deferred

- The delete flow refuses a referenced chain rather than cascading its references; a bulk "remove from all Profiles" action would need a two-namespace-free design (now possible within one document) but no user has asked for it.
- The hero chip is web-only; the desktop shell reuses the same slot when it composes the web client.
- `session.list` summaries do not carry the effective model Profile, so the chip re-reads it per current-session change via `session.models` rather than a summary field.
