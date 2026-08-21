# Agent Note: Scoped capability control plane

Status: implemented

English | [中文](2026-08-20-scoped-capability-control-plane.zh.md)

## Problem

Agent Profiles compose tools, skills, MCP clients, and delegation surfaces through plugin rows, but a runtime registry only describes what already mounted. Building a management catalog by mounting every healthy Profile loads plugins merely to inspect them and cannot express adding a row absent from the target Profile. Separate settings forms also cannot provide one inherited global/Profile composition, one dependency preview, or one rule for preserving running-session history.

## Decision

`dsh-capabilities` owns an extensible typed recipe catalog, inherited assembly overrides, and revision-fenced `plan`/`apply` transaction. A recipe may declare immutable model-discoverable members and an explicit Profile-safe configuration contract in addition to kind, provenance, owner, assembleability, implementation health, source defaults, manageability, and hard dependencies. `dsh-agent-presets` reads healthy Profile YAML files without mounting them and projects each top-level row or group as one recipe. Every target uses one deployment-wide recipe universe while preserving each Profile's native source defaults.

Global Agent values flow into every Profile and explicit Profile values override them. Omission means inherit and eventually falls back to the target YAML's native state. Selection, an explicit member allowlist, and owner-declared primitive configuration fields share this layering. The planner validates member ids and configuration fields in addition to automatically adding assembleable hard dependencies, blocking unknown, immutable, unassembleable, or dependency-breaking changes, and expiring a plan when Settings or adapter topology changes. Applying a plan writes desired composition only; legacy string selections normalize to the corresponding structured override.

When a Profile generation starts, the roster compiles desired selections and configuration into native `Include` patches: an unloaded source row becomes disabled, a selected recipe absent from the target inserts its canonical deployment row, Persona receives its complete resolved config, and config-gated built-in members such as Web or optional delegation tools receive native row values. The ordinary Loader still owns imports, injection waits, configuration validation, rollback, and plugin lifecycle. Generation-scoped Tool and Skill allowlists enforce discovery and execution through their native registries, including Code Mode nested dispatch. MCP clients publish server members dynamically and keep a Host-shared connection live while a Profile restriction hides the server or selected tools. Shared Subagent providers remain visible and read-only, while each Profile's delegation plugin group and model-facing members are selectable.

Agent Profile standing generations include effective selection, visible member ids, and resolved configuration in the composition signature. New Sessions join the latest generation, while existing Sessions remain parented to the generation whose schemas and history they already use. Hard activation failure prevents Session publication. Each successful generation captures immutable recipe and member outcomes; the authorized Session Remote exposes its generation id, resolved members, and loaded, not-loaded, load-failed, dependency-blocked, or security-denied states. Process-global read-only Cordis Inspect providers use explicit compatible shared leases, so Creator generations can coexist while ordinary duplicate providers still fail. This extends the scope ownership established by the [Agent scope runtime](2026-07-12-agent-scope-runtime-design.md) without turning a running model catalog into mutable session state.

The Host management Remote keeps catalog and Session runtime reads under `harniverse.observe` and requires `harniverse.administer` for planning and application. Plugin diagnostics remains an observation-only service. Web Settings stages local selection, member, and configuration edits, displays the Host plan and blockers, and submits only an unblocked plan id plus expected revision. Capability cards keep member and configuration controls collapsed behind concise summaries; the separate Session **Capabilities** view remains read-only.

## Alternatives considered

**Inspect mounted registries and apply deny filters.** Rejected because a catalog read would mount every Profile, an absent plugin could not be selected, and the UI would conflate implementation health with desired composition.

**One composition page per subsystem.** Dedicated Tool, Skill, MCP, and Subagent pages would duplicate target selection, inheritance, revision fencing, dependency planning, and session-generation rules. Adapters preserve native semantics behind one composition transaction instead.

**Mutate every running Session.** Adding or removing model-visible schemas after history exists breaks replay and tool-call continuity. Generation pinning gives new conversations the requested composition without rewriting active conversations; emergency revocation remains a separate monotonic runtime guard.

## Consequences

Users receive one global/Profile assembly editor, immutable built-in definitions with per-Profile member visibility, typed Persona configuration, dynamic Skill and MCP member selection, automatic hard-dependency selection, and one immutable runtime view per Session. Catalog reads perform filesystem parsing and Skill discovery but start no Profile plugin. Tool visibility does not replace sandbox or permission policy: another visible tool may provide the same effect. The Loader remains the lifecycle authority, and running Sessions remain stable. Top-level rows and groups remain the load unit while declared members refine their model-visible surface; semantic dependencies such as credentials, conflicts, soft dependencies, and optional `ctx.get()` paths remain conservative until recipes describe them.
