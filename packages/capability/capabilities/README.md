# @deepseek-ai/dsh-capabilities

English | [中文](README.zh.md)

Generic Agent Profile recipe catalog and composition coordinator. Native subsystems register effect-owned adapters on `ctx.capabilities`; an adapter projects JSON-safe descriptors and may apply unloaded selections to a standing Profile generation. Recipe descriptors distinguish whether an implementation is assembleable, currently healthy, selected by the source Profile, and manageable.

Selections persist in the `capabilities` Settings namespace. Global Agent values are inherited by every Profile, explicit Profile values override them, and omission falls back to the Profile YAML's native loaded state. `plan()` validates one staged transaction against exact composition and topology revisions, automatically loads declared hard dependencies, rejects unknown, immutable, unassembleable, or dependency-breaking changes, and retains an immutable dry-run. `apply()` accepts only that unchanged, unblocked plan. `dsh-agent-presets` compiles the result into native Loader patches when it creates the next standing generation.

## Model Experience

Indirectly, through selected Profile plugin rows that determine the tools, skills, prompts, and integrations mounted for new Sessions while existing Sessions retain their starting generation.

#### KV Cache effect

No direct effect. A changed composition can alter a new Session's visible tool schemas or skill catalog and therefore changes its reusable request prefix; running Sessions remain stable.

## Known Limitations and Deferred Work

- **Top-level Profile recipes** — Profile YAML top-level rows and groups are the selectable units; nested rows move with their owning group.
- **Declared dependency graph** — named providers, optional `ctx.get()` paths, conflicts, credentials, and soft dependencies require recipe metadata before the planner can reason about them.
