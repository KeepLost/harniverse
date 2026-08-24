# AGENTS.md

Harniverse is a DeepSeek Harness downstream on vendored Cordis: **everything is a plugin**. Before changing `packages/`, read [architecture.md](docs/architecture.md) and [PLUGINS.md](PLUGINS.md); follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Harniverse downstream contract

- [PLUGINS.md](PLUGINS.md) owns the official DSH baseline and downstream capability/composition ledger. Preserve upstream architecture and engineering processes unless a Harniverse decision changes them.
- Implement downstream behavior through documented plugin extension points. A capability includes its Service Definition, Service Provider, and Consumer roles; do not replace that seam with `agent-loop`, launcher, or bundle special cases.
- Update `PLUGINS.md` with every downstream package, capability, bundle, profile, preset, or shipped-composition change. Record the implementation SHA in a follow-up tracking commit; leave no placeholder.
- Every Remote declares a required `harniverse.*` capability, and business routes deny missing metadata. Only explicit authentication/bootstrap routes may be public. Preserve owner sealing, loopback-only bypass, and TLS for non-loopback Web listeners ([authentication](docs/subsystems/authentication.md)).
- Plugin diagnostics are observation-only. Repair, restart, disable, delete, configuration writes, and process control require a separate authorized capability ([diagnostics](docs/subsystems/plugin-diagnostics.md)).

## Pre-release stance: foundation over blast radius

**Remove this section at the first tagged Harniverse release.** Until a compatibility commitment exists, prefer the correct foundation over speculative shims: rename or repackage and update every reference together. Backends reject old formats. SQLite uses monotonic `SCHEMA_VERSION`; `SESSION_FORMAT_VERSION` remains `0` without compatibility promises.

## Repository orientation

Package responsibilities live in [packages/README.md](packages/README.md); subtree rules live in their `AGENTS.md` files. [vendor/README.md](vendor/README.md) governs pinned Cordis.

## Commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run clean           # remove build outputs and safe residue
pnpm run test            # full build, then vitest unit tests
pnpm run test:coverage   # CI coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e        # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:snapshot   # keyless replay; filter with -t <name>
pnpm run test:snapshot:record  # re-record expected outputs (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication     # cross-file TypeScript clone detection
pnpm run build           # tsc emits lib/types, tsdown bundles runtime
pnpm run hygiene         # package/static gates
pnpm run check:windows-wine  # known Windows failure only; needs wine
pnpm run doc-sync        # all documentation gates; leaf list in scripts/run-gates.ts
pnpm run website:build   # VitePress build and dead-link check
pnpm dsh --profile headless "task"  # source task; needs a model credential
pnpm run demo:cordis     # live plugin demo; needs a key
pnpm run demo:acp        # ACP automation server; needs DEEPSEEK_API_KEY
```

### Run relevant checks locally

Use [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) before pushes; report commands run. Validate after `gh stack sync`; do not merge before checks pass.

- Repository-level test completion includes `pnpm run build`; use `pnpm run test`, which enforces build-before-unit ordering. Use `pnpm run test:unit` only in a scheduler gate that depends on build or for explicitly focused diagnosis.
- Match evidence to the surface: focused tests for behavior, snapshots for visible output, `doc-sync` for docs, built checks for published paths, and real-API e2e for providers.
- Do not default to the full suite or repeat passing checks for commit/push. CI owns exhaustive coverage and the platform matrix; rehearse all only by request, CI diagnosis, or repository-wide change.
- `test:coverage`, not `test`, is the CI coverage gate ([testing policy](docs/testing.md)).

## Secrets and configuration

Real-API tests and demos read provider credentials and root `.env`; never commit them. `cordis.yml` permits `!!js` (never `!js`) only under plugin `config` and entry `disabled`; conditional composition otherwise uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). [testing.md](docs/testing.md) owns key policy.

## Conventions

- Keep the inherited `@deepseek-ai/dsh-<name>` namespace unless an approved distribution change replaces it. Vendored packages are rescoped and private; every harness package declares `@deepseek-ai/cordis` as peer plus dev dependency.
- ESM everywhere. Use package names across packages and `.ts` for local relative imports. Config subprocesses run built `lib/`; source regressions use their declared launcher. Bare config plugins appear in their resolver manifest's dependencies ([development](docs/development.md#typescript-project-layout)).
- **Registrations are effects:** every contribution uses `ctx.effect()` / `ctx.on()`; a registry's `register()` returns its disposer.
- Runtime invariants assert owned event/data relationships, not service presence, metadata, effects, or fixed examples. Without one, use an explained empty companion ([package rules](packages/AGENTS.md)).
- Typed events use declaration merging and documented dispatch modes. Session events are required-on-read unless `ignorable`; only structural format changes bump `SESSION_FORMAT_VERSION`.
- Closed unions end in `assertNever`; extensible unions use a documented default.
- Waterfall listeners call `next()` to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible means logged:** anything reaching a model request is reconstructable from the Session log; new model-visible input requires a session event.
- New behavior uses documented plugin extension points. Changing `agent-loop` requires updating [architecture.md](docs/architecture.md).
- A capability seam comprises Definition, Provider, and Consumer roles; split only independently evolving roles ([glossary](docs/glossary.md#capability-seam)).
- Prefer maintained dependencies when they delete owned code and tests. Resolve defaults explicitly in the owning implementation.
- Deployment choices are validated plugin `Config`; protocol constants and security invariants stay fixed. Misconfiguration fails at the earliest resolvable point.
- Brand opaque cross-boundary ids. Trust typed same-process values; validate parser/config, queued, model/tool JSON, durable/file, worker, process, and wire inputs.
- Source and artifact planes never mix: static checks resolve `src`; built consumers declare their `lib/` dependency. Each package uses one compiler aggregate except `api/remotes`; repo-wide programs seed a Host or Client face.
- An empty `catch` names what it swallows and why; keep its `try` to one statement. Do not comment on facts obvious from code. Prefer symmetry for parallel values.
- Tests describe behavior; change obsolete behavior with its tests. Non-trivial changes include an Agent Note; archives are frozen ([scope](.agents/notes/README.md#when-to-write-one)).
- Non-trivial model-, protocol-, or user-visible changes update a keyless snapshot through a real composition; package/mock tests do not replace assembled behavior ([testing policy](docs/testing.md)).
- Decide a tool's UI render intent with its design ([tool cookbook](docs/cookbook/adding-a-tool.md)). Plan unit, e2e, and snapshot evidence for capability seams and lifecycle/output changes.
- Choose PR history deliberately. Split independent changes; fix the introducing PR before propagation. Rewrites use `--force-with-lease`, stop on remote movement, and never use raw `--force` ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- Labels use one `kind/*`, every material `area/*`, and a native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- TODO markers use `FIXME`, `TODO`, and `XXX` by urgency ([semantics](docs/development.md#todo-markers)). Files end with exactly one newline; `git diff --cached --check` gates whitespace.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true`; every remaining `any` explains why narrowing is infeasible. Modules and exports have concise JSDoc for non-obvious contracts; function-like exports document parameters and non-void returns.

Comments and docs state current contracts, not reasoning, control-flow narration, review history, or code restatement. Keep rationale in Agent Notes and enforce invariants in a top-level gate. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md).

Docs accompany code changes: update affected README and JSDoc contracts together. Routine bilingual work follows [docs/AGENTS.md](docs/AGENTS.md); only explicit user invocation may run `dsh-translate-docs`.

## Editing these instructions

Treat an `AGENTS.md` change as a standalone task: show the complete draft and obtain explicit approval before editing. `CLAUDE.md` symlinks it at root, `packages/`, and `examples/`; edit the real file. Link detailed owners and condense before raising a budget.

## Upstream and vendoring policy

An official DSH sync adds a dated `PLUGINS.md` baseline and reconciles every downstream change; never replace its immutable ledger silently. Update pinned `vendor/` packages through [vendor/README.md](vendor/README.md), reconcile local modifications, then run `pnpm run test && pnpm run build`.
