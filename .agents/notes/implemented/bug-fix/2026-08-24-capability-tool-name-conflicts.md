# Agent Note: Tool-name conflicts must not fail a Profile generation

Status: implemented

English | [中文](2026-08-24-capability-tool-name-conflicts.zh.md)

## Problem

Selecting the persistent shell on a `standard`-family Agent Profile left the Web UI unable to start a session: the workspace could not be selected and no message could be sent. The Host logged `failed to apply loader entry persistent-bash` caused by `tool "bash" is already registered in this scope`.

Two shipped recipes register the same model-facing tool name. `plugin:tool-bash` owns `bash`, and `plugin:persistent-shell` — the group holding `dsh-tool-bash-persistent` — registers `bash` as well. Their native defaults differ per Profile: `standard`, `code`, and `cordis` load `tool-bash` and leave `persistent-shell` off, while `minimal` does the reverse. Loading the persistent shell on a `standard`-family Profile therefore left both selected.

A tool name has exactly one owner per scope, so the second registration threw. The throw happened inside the standing Profile mount, where a row that fails to activate fails the whole generation — `mountPreset` rejects on any inactive row. Because that generation is what an Agent joins, no Agent could be composed at all, which is why the failure surfaced as a dead workspace picker and a disabled composer rather than as one missing tool.

Nothing rejected the selection when it was made. `capabilities.plan` validated selection manageability, assembly recipes, hard dependencies, member ids, and configuration fields, but never checked whether two selected capabilities claim one registry name. The collision was therefore accepted at edit time and only discovered at mount, after it was already stored.

## Decision

`capabilities.plan` reports a `member-name-conflict` blocker when two selected capabilities expose the same visible member name of one kind. The catalog already knows every visible member before anything mounts, so the collision is decidable at plan time, and `apply` refuses a blocked plan through the existing gate. The blocker names both claimants so an operator can see which pair to resolve. Only visible members of selected capabilities count: a hidden member registers nothing, and an unselected capability contributes nothing.

`compositionPatches` additionally compiles an already-stored conflict into a mountable generation. When two selected recipes claim one tool name, the row this Profile does not load natively keeps the name and the colliding native row is disabled. Turning a non-default row on is the operator's explicit choice, while the row it collides with is only the Profile's default, so disabling the default is what the selection asked for. With no such distinction the first claimant keeps the name, which keeps the outcome stable rather than order-dependent.

Both halves are needed. The blocker prevents new conflicts, but a Profile stored before the gate existed — or edited outside it — must still boot; without the compile-side recovery those Profiles stay permanently unable to start a session, and the blocker cannot help because the damage is already persisted.

## Scope

This is a composition-planning and patch-compilation change. It does not alter Remote capability requirements, authentication, persistence formats, the tools registry's single-owner rule, or which tools a non-conflicting Profile composes. The registry still rejects a duplicate registration; what changes is that a conflicting selection is refused before it is stored and neutralized when it already is.

The single-owner rule itself is deliberately untouched. Two implementations of one tool name are a genuine contradiction, and silently letting one win inside the registry would make "which bash am I calling" unanswerable from the composition.

## Testing

The capabilities spec pins the blocker on the exact shipped shape: two capabilities each exposing a visible `bash` member, one loaded by default and one selected on top, then asserts `plan` reports `member-name-conflict` and `apply` rejects the blocked plan.

The composition spec pins the recovery against the real shipped Profiles rather than a fixture: it builds the `standard` catalog, selects `plugin:persistent-shell` while `plugin:tool-bash` stays natively loaded, asserts both are in fact selected, and requires the compiled patches to disable `tool-bash`. Reading the shipped files is what makes the test track the actual defect; a fixture could drift away from the collision that occurs in production.

The recovery assertion was falsified by removing the shadow application from `compositionPatches` and confirming it fails, so it observes the compiled patch rather than passing vacuously. A probe over all four shipped Profiles confirmed the default matrix the decision relies on before either fix was written.

## Alternatives considered

**Let the registry accept a duplicate and keep the last registration.** Rejected because two owners of one tool name is a contradiction, not a merge. The registry's single-owner rule is what makes a composition legible; weakening it would hide every future collision instead of surfacing this one.

**Fail only the colliding row and mount the rest of the generation.** Rejected because a partially composed Profile is worse than a refused one: the Session would start with a silently missing tool, and `mountPreset`'s all-rows-active contract is what guarantees a generation matches its recorded composition.

**Rename the persistent shell's tool to `bash_persistent`.** Rejected because the two rows are alternative implementations of one model-facing capability, and the tool name is a model-visible contract. Renaming would make the two Profiles present different tool vocabularies for the same action and would change `minimal`'s existing model surface.

**Only add the plan blocker.** Rejected because it leaves every already-stored conflict permanently broken. The reported failure came from persisted state, which a plan-time gate cannot reach.

**Only add the compile-side recovery.** Rejected because it would silently drop a capability the operator explicitly selected without ever telling them the selection was contradictory. The blocker is what keeps the choice visible at the moment it is made.

**Have the shipped `standard` Profile disable `tool-bash` next to `persistent-shell`.** Rejected because it fixes one pair in one Profile by hand. The collision is a property of any two recipes sharing a member name, including recipes a user authors, so the rule belongs in the planner and the compiler.

## Consequences

A conflicting selection is now refused at edit time with both claimants named, and a Profile that already stored one composes successfully with the opted-in row owning the name. The session-blocking failure mode — a Profile generation that cannot mount, presenting as an unselectable workspace and a disabled composer — is gone for this class of conflict.

The cost is that a stored conflict resolves silently at compile time rather than announcing itself. That is bounded by the blocker: reaching this state requires state written before the gate existed or edited outside the UI, and the compiled generation still reports its resolved members through the Capabilities view, so what the Session actually runs stays inspectable.

`member-name-conflict` is a new blocker code in a public union. Consumers that switch exhaustively over blocker codes must handle it; the shipped Web UI renders blocker messages generically and needed no change.
