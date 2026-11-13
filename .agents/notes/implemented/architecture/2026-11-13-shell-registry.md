# Agent Note: Shell registry — session-selectable shells with one resolver

Status: implemented

English | [中文](2026-11-13-shell-registry.zh.md)

## Problem

The shell-backend preference was Windows-only by vocabulary (`'platform-default' | 'git-bash'`; `resolveShellBackend` collapsed every non-win32 stored value to bash), while the owner wanted every OS to offer shell selection: a settings-page registry of shells, session-creation-time choice defaulting to the settings default, and mid-session switching when a shell goes invalid. The hard requirement underneath: the model must always know exactly which shell it runs under — "model believes X, executor runs Y" must be impossible — and every change must reach the model accurately and promptly.

## Decision

A three-layer generalization over the existing routed-shell seam, with the macOS fact-text lie (fact said bash, executor ran zsh) fixed by the same move:

- **Vocabulary first** (`@deepseek-ai/dsh-shell`): the stored stack preference becomes `'platform-default' | 'bash' | 'pwsh'` honored on every platform; a registry model joins it — builtin ids `posix`/`pwsh` (never removable), custom entries `{id, path, label?}`, a dialect-class classifier (POSIX bash/zsh/sh/dash/ksh and PowerShell route to the two composed stacks; fish/nu reject loudly at settings validation), and ONE resolver `resolveEffectiveShell(registry, override, probeTable)` returning `{entryId, label, stack, executablePath, factText, degraded?}`. Pre-registry log values fold: legacy `'bash'`→`posix`, `'pwsh'` is already a builtin id, so replay needs no migration; `SESSION_FORMAT_VERSION` stays 0 under the additive policy (digest re-verified).
- **Registry settings + boot discovery**: `shell-backend-settings` repurposed (pre-release rename) into `shell-registry-settings`, owning namespace `shell-registry` (`applies: 'restart'`) and exposing the resolved document as the `shellRegistry` service. The boot bridge reads the stored document once per start and publishes `$DSH_SHELL_BACKEND` (stack; explicit env still wins) plus `$DSH_SHELL_DEFAULT_PATH` (a custom default's executable, for single-stack base compositions). The router probes builtins AND every registry entry through `resolveExecutable` in the execution world; a family mounts when any probed shell routes to it; `availability()` widens to per-entry status plus the default entry; unstamped requests to the default family carry its probe-resolved absolute path.
- **Session selection with promise carrying** (`dsh-session-shell`): the durable override becomes an entry id (`session-shell/change` payload widened, legacy folded at replay); `switch(agent, entry)` validates against the probe table; `session.create` accepts an optional `shell` (validated BEFORE anything is created; the birth event persists even when it equals today's default, so later default changes never shift a pinned session); `host.describe` carries a boot-stable shell snapshot for the creation drawer; `session.shell`/`session.switchShell` speak entries.

Three hard rules make X-vs-Y structurally impossible, enforced where the decision is made:

1. **One source**: the prompt fact, the tool-catalog restriction, and the execution stamp all derive from `resolveEffectiveShell`; no consumer resolves a shell on its own.
2. **One materialization**: each `systemPrompt.assemble` freezes the session's effective shell as the dispatch promise (every assemble consumer is model-visible by contract, so a re-freeze always rides text the model sees); `dsh-tool-bash`/`dsh-tool-pwsh` stamp `shellPath` from that promise only when the promise carries a materialized executable — the entry's probe-resolved absolute path, or an absolute configured path verbatim — and executors spawn the stamped path verbatim, never a PATH re-resolution. An unprobed bare-PATH-name entry stamps nothing and the owning executor resolves through its own platform knowledge (`dsh-pwsh-local`'s well-known locations and Windows PowerShell 5.1 fallback), so a host whose shells the PATH probe cannot see still executes (2026-11-13 regression fix: bare-name stamps overrode that resolution and failed `spawn pwsh ENOENT` on Windows hosts with Store or non-PATH installs). A mid-request switch therefore cannot make an in-flight call run a shell its request was not told about.
3. **Fail closed in the resolver**: an orphaned or unavailable target degrades to the platform builtin INSIDE the resolver with a reported `degraded` reason, and the fact names the shell that actually runs; switches to unavailable entries refuse; explicit create-time choices to unavailable entries fail the create.

The fact line names the actual executable's basename (never the entry id) and its syntax class, with the declared path shown only for absolute-path entries so PATH-named builtins keep host-stable text. The first assembly after a switch appends one pinned change notice (`The session shell changed from X to Y; shell commands now run under Y.`); in-flight requests complete on their frozen promise.

## Alternatives considered

- **Widen the old family union per OS** (add zsh/fish as families): rejected — families are composed stacks (executor + tool + dialect contract); a registry of executables routing through the two real stacks delivers the freedom without shipping untested stacks.
- **Env-only threading of entries to the router**: rejected — the settings document is the user-owned source; the bridge publishes only the boot-stable stack (+ default path), while probing reads the in-process `shellRegistry` service.
- **Push-based availability events for mid-session invalidation**: rejected — mounts happen at boot; the runtime face of "shell died" is a failed call, so availability re-reads reactively (switch failure / panel rebind) instead of a speculative channel.
- **Silent fallback to a same-stack sibling on an unavailable entry**: rejected — explicit user choice is trust; the resolver's degradation reports itself and the fact follows the truth.
- **Neutral `shell` tool rename**: rejected for now — the prompt fact carries the real shell identity; renaming tools changes the model-visible surface broadly for zero functional gain (door left open).

## Consequences

- Windows semantics preserved (`platform-default`→pwsh; `bash`/`posix`→Git Bash stack) while macOS/Linux gain real selection, including pwsh-on-unix (supported matrix: CI gains a `DSH_SHELL_BACKEND=pwsh` linux lane in the web bundle's environment).
- The old `shell-backend` namespace and the `git-bash` value die in the pre-release window: settings documents carrying them fail loudly at load with a one-line migration (`shell-registry: default: bash→posix`).
- Entry CRUD UI, the creation-drawer selector, and the entry-level terminal-panel switcher are the follow-up PR; this change ships the seams, the RPC surface, and the stack-level UI adaptation.
- Single-stack hosts keep `switchable: false` (no router, no per-session switching); their custom-default executable arrives via `$DSH_SHELL_DEFAULT_PATH` into the executor config only when its stack matches the composed one.

## Verification

- Unit: resolver (defaults/explicit/unavailable/orphan/legacy fold/fact pinning/unprobed bare-name stamps nothing), router (entry probing, family-via-entry mounting, default-entry adoption, env pin, default-path stamping), settings contract (slug/reserved/duplicate/dialect/default validation), session-shell (effective resolution, serialized switching, legacy vocabulary, dispatch-promise freeze and mid-request stability, change notice riding exactly one assembly, restriction by stack, orphan degradation), boot bridge (document shapes, override precedence, path publication rules).
- REAL composition: the registry loader smoke boots seeded document → boot bridge → flag pair through the actual Loader; bundle specs pin the XOR gating; session digest re-verified unchanged.
- Fact/golden: the builtin fact line stays byte-stable on PATH-named hosts (goldens unchanged); web e2e settings section retargeted to `shell-registry`.

<!-- dsh-translate-docs: language-switch(en, zh) -->
