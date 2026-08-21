# Agent Note: Scoped capability control plane

Status: implemented

English | [中文](2026-08-20-scoped-capability-control-plane.zh.md)

## Problem

Agent Profiles compose tools, skills, MCP clients, and delegation surfaces through plugin rows, but a runtime registry only describes what already mounted. Building a management catalog by mounting every healthy Profile loads plugins merely to inspect them and cannot express adding a row absent from the target Profile. Separate settings forms also cannot provide one inherited global/Profile composition, one dependency preview, or one rule for preserving running-session history.

## Decision

`dsh-capabilities` owns an extensible typed recipe catalog, inherited load/unload selection, and revision-fenced `plan`/`apply` transaction. `dsh-agent-presets` reads healthy Profile YAML files without mounting them and projects each top-level row or group as one recipe with kind, provenance, owner, assembleability, implementation health, source default, manageability, and hard dependency ids. Every target uses one deployment-wide recipe universe while preserving each Profile's native source defaults.

Global Agent values flow into every Profile and explicit Profile values override them. Omission means inherit and eventually falls back to the target YAML's native state. The planner automatically adds assembleable hard dependencies, blocks unknown, immutable, unassembleable, or dependency-breaking changes, and expires a plan when Settings or adapter topology changes. Applying a plan writes desired composition only.

When a Profile generation starts, the roster compiles desired selections into native `Include` patches: an unloaded source row becomes disabled, while a selected recipe absent from the target inserts its canonical deployment row. The ordinary Loader still owns imports, injection waits, configuration validation, rollback, and plugin lifecycle. MCP clients register their server identity explicitly; unloading a Host-shared server installs a refreshed Profile restriction over every tool generation while its connection remains live. Shared Subagent providers remain visible and read-only, while each Profile's delegation plugin group is selectable.

Agent Profile standing generations include the effective composition signature. New Sessions join the latest generation, while existing Sessions remain parented to the generation whose schemas and history they already use. Hard activation failure prevents Session publication. Each successful generation captures immutable recipe outcomes; the authorized Session Remote exposes its generation id and loaded, not-loaded, load-failed, dependency-blocked, or security-denied states. Process-global read-only Cordis Inspect providers use explicit compatible shared leases, so Creator generations can coexist while ordinary duplicate providers still fail. This extends the scope ownership established by the [Agent scope runtime](2026-07-12-agent-scope-runtime-design.md) without turning a running model catalog into mutable session state.

The Host management Remote keeps catalog and Session runtime reads under `harniverse.observe` and requires `harniverse.administer` for planning and application. Plugin diagnostics remains an observation-only service. Web Settings stages local inherit/load/unload edits, displays the Host plan and blockers, and submits only an unblocked plan id plus expected revision. A separate Session **Capabilities** view is read-only.

## Alternatives considered

**Inspect mounted registries and apply deny filters.** Rejected because a catalog read would mount every Profile, an absent plugin could not be selected, and the UI would conflate implementation health with desired composition.

**One composition page per subsystem.** Dedicated Tool, Skill, MCP, and Subagent pages would duplicate target selection, inheritance, revision fencing, dependency planning, and session-generation rules. Adapters preserve native semantics behind one composition transaction instead.

**Mutate every running Session.** Adding or removing model-visible schemas after history exists breaks replay and tool-call continuity. Generation pinning gives new conversations the requested composition without rewriting active conversations; emergency revocation remains a separate monotonic runtime guard.

## Consequences

Users receive one global/Profile assembly editor, one stable catalog shape across targets, automatic hard-dependency selection, and one immutable runtime view per Session. Catalog reads perform filesystem parsing but start no Profile plugin. The Loader remains the lifecycle authority, and running Sessions remain stable. Top-level rows and groups are the current selection unit, so nested rows move together; semantic dependencies such as named providers, credentials, conflicts, soft dependencies, and optional `ctx.get()` paths remain conservative until recipes describe them.
