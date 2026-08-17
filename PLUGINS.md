# Harniverse Plugin Inventory

This document records the exact DeepSeek Harness plugin baseline imported by Harniverse and the downstream plugin changes made on top of it. It distinguishes npm package inventory, Cordis plugin roles, capability seams, and shipped composition changes; package count alone does not describe the architecture.

## Comparison Baseline

| Item | Value |
|---|---|
| DeepSeek Harness commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Harniverse import commit | `440d2ae5a426613bd14c4c601a90f79e4b01c149` |
| Shared tree | `f904efab9ef435201d6ba4da88a34d6366568272` |
| Current Harniverse commit at document creation | `795f93ba8409686add70978d86b56a4e9b6caae0` |
| Official `packages/*/*` package count | 219 |

The two baseline commits have the same Git tree. All downstream statements therefore describe `440d2ae5a4..HEAD` without upstream-version ambiguity. The official inventory below covers first-party packages under `packages/*/*`; vendored Cordis packages are framework dependencies, while `apps/*` are launchers and assembled application hosts.

## Official Plugin Inventory

<!-- official-inventory-start -->
The inventory is grouped by package directory. Every listed package is an official first-party workspace package at the baseline tree; a package may expose a Service Definition, Service Provider, Consumer, bundle, UI plugin, support plugin, or more than one tightly coupled role.

| Group | Count | Packages |
|---|---:|---|
| `acp` | 1 | `acp` |
| `api` | 2 | `gateway`, `remotes` |
| `attachment` | 2 | `attachment`, `attachment-local` |
| `boot` | 2 | `app-boot`, `cmdline` |
| `bundle` | 3 | `base`, `headless`, `web-app` |
| `client` | 39 | `connection`, `hmr`, `locale`, `modules`, `runtime`, `schema-form`, `ui-agent-preset`, `ui-attachment`, `ui-commands`, `ui-conversation`, `ui-deliverables`, `ui-directory-picker-browse`, `ui-directory-picker-native`, `ui-goal`, `ui-input-trigger`, `ui-jobs`, `ui-layout`, `ui-message-feedback`, `ui-model-selection`, `ui-permission-presets`, `ui-plan`, `ui-primitives`, `ui-settings`, `ui-settings-general`, `ui-settings-models`, `ui-settings-plugin-inventory`, `ui-settings-plugins`, `ui-sidebar`, `ui-skill`, `ui-slots`, `ui-subagent`, `ui-theme`, `ui-tool`, `ui-trajectory`, `ui-user-questions`, `ui-workflow-run`, `ui-workspace`, `web`, `web-react` |
| `code-runtime` | 2 | `code-runtime`, `code-runtime-worker-thread` |
| `compaction` | 4 | `command-compact`, `compaction`, `compaction-basic`, `compaction-tool-result-pruner` |
| `context` | 4 | `agent-instructions`, `session-reference`, `time-context`, `tmux-context` |
| `core` | 8 | `agent`, `agent-default-model`, `agent-loop`, `agent-tool-presentation`, `scope`, `session`, `system-prompt`, `tools` |
| `credentials` | 2 | `credentials`, `credentials-local` |
| `e2b` | 3 | `e2b`, `fs-e2b`, `subprocess-e2b` |
| `examples` | 3 | `acp-demo`, `agent-spine-demo`, `jsonrpc-demo` |
| `extensions` | 4 | `cordis-client-runner`, `cordis-host-runner`, `tool-cordis`, `ui-cordis` |
| `feedback` | 2 | `command-feedback`, `message-feedback` |
| `fs` | 7 | `fs`, `fs-local`, `fs-observation-policy`, `fs-sandbox`, `tool-fs`, `tool-fs-search`, `tool-str-replace-editor` |
| `goal` | 4 | `command-goal`, `goal`, `goal-round-driver`, `tool-goal` |
| `guard` | 2 | `repeat-tool-reminder`, `timeout-policy` |
| `hooks` | 3 | `hook-protocol`, `hooks-claude-code`, `hooks-codex` |
| `host` | 8 | `apiproxy`, `directory-picker`, `directory-picker-auto`, `directory-picker-browse`, `directory-picker-native`, `frontend-static`, `plugin-inventory`, `webserver` |
| `identity` | 1 | `anonymous-user-id` |
| `interaction` | 5 | `commands`, `permission-presets`, `tool-ask-user`, `user-approval`, `user-questions` |
| `jobs` | 3 | `jobs`, `jobs-local`, `tool-jobs` |
| `llm` | 5 | `llm`, `llm-deepseek`, `llm-pi-ai`, `llm-retry`, `token-meter` |
| `lsp` | 3 | `lsp`, `lsp-stdio`, `tool-lsp` |
| `mcp` | 1 | `mcp-client` |
| `plan` | 1 | `plan-mode` |
| `preset` | 2 | `agent-presets`, `persona` |
| `runtime-diagnostics` | 1 | `invariants` |
| `sandbox` | 4 | `sandbox`, `sandbox-local`, `sandbox-policy`, `sandbox-windows-acl` |
| `schedule` | 1 | `schedule` |
| `sdk` | 3 | `client`, `protocol`, `server` |
| `session-query` | 4 | `session-log-export`, `session-query`, `session-query-sqlite`, `tool-session-query` |
| `session` | 13 | `session-checkpoint-policy`, `session-persistence`, `session-persistence-jsonl`, `session-persistence-sqlite`, `session-projection`, `session-projection-cache`, `session-stats`, `session-telemetry`, `session-telemetry-otel`, `session-title`, `session-title-all-prompts-llm`, `session-title-first-prompt-llm`, `session-title-llm` |
| `settings` | 2 | `settings`, `settings-file` |
| `shell` | 9 | `bash-local`, `bash-sandbox`, `pwsh-local`, `pwsh-sandbox`, `shell`, `shell-env`, `tool-bash`, `tool-bash-persistent`, `tool-pwsh` |
| `skill` | 4 | `skill`, `skill-badge`, `skill-filesystem`, `tool-skill` |
| `spill` | 3 | `spill`, `spill-local`, `spill-policy` |
| `storage` | 4 | `storage`, `storage-domain`, `storage-json`, `storage-sqlite` |
| `subagent` | 11 | `subagent`, `subagent-acp`, `subagent-claude-code`, `subagent-codex`, `subagent-dsh-sdk`, `subagent-fork-in-process`, `subagent-in-process-driver`, `subagent-spawn-in-process`, `tool-subagent`, `tool-subagent-control`, `tool-subagent-report` |
| `subprocess` | 2 | `subprocess`, `subprocess-local` |
| `terminal` | 3 | `terminal`, `terminal-bash`, `tool-terminal` |
| `test-support` | 6 | `acp-snapshot`, `agent-loop-testkit`, `client-runtime`, `llm-mock-server`, `llm-replay`, `loader-smoke` |
| `todo` | 1 | `tool-todo` |
| `typert` | 4 | `generator`, `loader`, `protocol`, `registry` |
| `util` | 7 | `atomic-write`, `brand`, `home-paths`, `launch-environment`, `native-command`, `output-retention`, `timeout` |
| `web` | 6 | `tool-web`, `web`, `web-fetch-http`, `web-search-deepseek`, `web-search-exa`, `web-search-perplexity` |
| `workflow` | 4 | `tool-ralph`, `tool-workflow`, `workflow`, `workflow-worker-thread` |
| `workspace` | 1 | `workspace` |
<!-- official-inventory-end -->

## Harniverse Capability Changes

<!-- capability-changes-start -->
Harniverse did not add six independent capabilities. Six downstream package manifests occupy roles in three capability families plus one profile bundle that exposes authentication management through the plugin tree.

| Capability | Service Definition | Service Provider | Consumer | Current downstream status |
|---|---|---|---|---|
| Inbound authentication | `dsh-authentication` (new) | `dsh-authentication-local` (new) | `dsh-client-connection` (official, modified), `dsh-auth-app` (new management bundle) | Complete seam; runtime and management entry points both compose through plugins. |
| Outbound notification | `dsh-notification` (new; Definition + coordinator Consumer) | `dsh-notification-http` (new) | Coordinator folded into `dsh-notification` | Complete opt-in seam following the official session-telemetry pattern. |
| Durable result artifacts | `dsh-spill` (official, modified) | `dsh-spill-local` (official, modified) | `dsh-tool-result-artifacts` (new), `dsh-spill-policy` | Complete seam; one Consumer owns retention, recovery marker, failure semantics, and `artifact_read`. |

### Added Packages

| Package | Role | Default composition |
|---|---|---|
| `@deepseek-ai/dsh-authentication` | Inbound authentication Service Definition | Type/service dependency; the concrete Web row loads its Provider. |
| `@deepseek-ai/dsh-authentication-local` | Local named-token Service Provider | Enabled by `dsh-web-app`. |
| `@deepseek-ai/dsh-auth-app` | One-shot authentication management bundle and Consumer | Shipped as the standalone `auth` profile; `dsh auth` is its alias. |
| `@deepseek-ai/dsh-notification` | Notification Service Definition plus lifecycle projection Consumer | Not mounted alone. |
| `@deepseek-ai/dsh-notification-http` | Durable HTTP/HTTPS notification Service Provider | Opt-in examples only. |
| `@deepseek-ai/dsh-tool-result-artifacts` | Finalized-result retention and model-facing retrieval Consumer | Enabled in base/headless scopes and per-agent Web presets. |

### Modified Official Plugin Families

| Area | Official packages changed by Harniverse |
|---|---|
| Model and Web defaults | `dsh-base`, `dsh-web`, `dsh-web-search-exa`, `dsh-web-search-perplexity`, `dsh-client-ui-settings-models`, `dsh-client-ui-settings-plugins` |
| Session control and reconnect | `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-host-apiproxy`, `dsh-client-connection`, `dsh-client-runtime`, `dsh-session-persistence`, `dsh-session-persistence-jsonl`, `dsh-session-persistence-sqlite`, `dsh-session-projection-cache`, `dsh-workspace` |
| Result retention and bounded file access | `dsh-tools`, `dsh-spill`, `dsh-spill-local`, `dsh-spill-policy`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`, `dsh-client-ui-tool`, `dsh-compaction`, `dsh-token-meter` |
| Authenticated Web surface | `dsh-web-app`, `dsh-client-connection`, `dsh-client-web`, `dsh-host-webserver` |
| Derived runtime catalogs | `dsh-cordis-client-runner`, `dsh-tool-cordis` |
| Test support projection | `dsh-acp-snapshot` normalization only |
<!-- capability-changes-end -->

## Shipped Composition Changes

<!-- composition-changes-start -->
| Composition surface | Current Harniverse change |
|---|---|
| `dsh-base` model adapters | Native `dsh-llm-deepseek` remains installed but defaults disabled; official `dsh-llm-pi-ai` is the enabled vendor-neutral adapter. |
| `dsh-base` Web providers | Existing Exa and Perplexity providers are mounted beside DeepSeek; provider selection is live settings-backed. |
| `dsh-base` model Web tools | `dsh-tool-web` remains loaded with both search and fetch disabled by default. |
| `dsh-base` result policy | Legacy `dsh-spill-policy` and `dsh-compaction-tool-result-pruner` rows default disabled; `dsh-tool-result-artifacts` handles finalized-result retention and `artifact_read`. |
| `dsh-web-app` authentication | `dsh-authentication-local` initializes before WebServer bind; connection injects the provider-neutral service. |
| `dsh-web-app` transport | Non-loopback listeners require direct TLS; authentication bypass is loopback-only. |
| `auth` profile | `dsh-auth-app` parses token-management arguments inside the plugin tree and exits without mounting an Agent, WebServer, or authentication runtime Provider. |
| Notification | No shipped bundle mounts `dsh-notification-http`; explicit examples compose Storage plus the Provider. |

### Downstream Commit Ledger

| Commit | Plugin-level effect |
|---|---|
| `ae7c9b6d5b` | Makes the shipped model-provider composition vendor-neutral and removes the DeepSeek-specific onboarding occupant. |
| `e054be808c` | Adds explicit Agent/Session close, cold deletion, resumable event cursors, projection-cache deletion, and workspace cleanup across existing plugins. |
| `27f702fac1` | Adds explicit all-interface Web startup acknowledgement; later superseded by authentication and TLS requirements. |
| `313a859200` | Mounts configurable DeepSeek/Exa/Perplexity search providers and adds live settings/UI selection. |
| `fd707f8b78` | Disables the model-facing native Web tool surface in shipped defaults. |
| `a9fab6b33b` | Adds the outbound notification Definition/coordinator and durable HTTP Provider. |
| `7b11e67e00` | Adds durable final-result artifacts, `artifact_read`, bounded readers/search, stronger compaction evidence, and accurate auxiliary usage. |
| `5dde5cdc6f` | Adds inbound authentication Definition/Provider, Web transport enforcement, browser login, and token management. |
| `c44c47bbba` | Makes the read-result UI accept bounded pages without an exact total line count. |
| `795f93ba84` | Requires TLS for non-loopback Web serving, adds secure cookies and peer-aware auth failure limiting, and fixes auth lock teardown. |
<!-- composition-changes-end -->

## Architecture Refactor Ledger

<!-- refactor-ledger-start -->
Status: **refactor implemented in the current worktree**.

| Refactor | Problem | Target state | Status |
|---|---|---|---|
| Auth management App | Universal launcher parsed provider-specific token grammar and imported `dsh-authentication-local` outside the plugin tree. | The minimal `dsh-auth-app` bundle/profile owns parsing and execution; `dsh auth` is only a profile alias. | Complete |
| Tool final-result extension | `dsh-tools` owned spill policy and hardcoded a separately composed Consumer after definition finalization. | `dsh-tools` exposes the generic asynchronous `tools/finalize-result` waterfall before immutable commit. | Complete |
| Result artifact Consumer | Retention and `artifact_read` could be composed independently even though successful retention promised the tool existed. | `dsh-tool-result-artifacts` owns retention, marker, failure semantics, and retrieval tool in one plugin. | Complete |
| Spill reference contract | `SpillRef.retrievalHint` let a storage Provider own model-facing wording. | `SpillRef` carries only opaque locator and exact bytes; Consumers own presentation. | Complete |
| Notification role projection | Generated capability tables showed no Consumer even though the Definition package folds the coordinator Consumer. | Generated graphs explicitly label the bundled coordinator role for notification and session telemetry. | Complete |

The base bundle, four Web agent presets, standalone auth profile, package manifests, and generated catalogs use these final package boundaries.
<!-- refactor-ledger-end -->

## Maintenance Rules

- Update this file in the same change that adds, removes, renames, combines, or splits a first-party plugin package.
- Record a capability as the complete Service Definition / Service Provider / Consumer relationship; never present constituent packages as independent capabilities unless they actually are.
- Record bundle, profile, preset, and scope changes separately from package inventory changes.
- Mark generated catalogs, tests, and documentation as supporting projections rather than runtime plugin packages.
- Keep the baseline immutable. Upstream synchronization must add a new dated baseline section rather than silently replacing the imported tree.
