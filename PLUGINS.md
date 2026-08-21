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
| `session-query` | 7 | `session-delivery`, `session-delivery-local`, `session-log-export`, `session-query`, `session-query-sqlite`, `tool-session-delivery`, `tool-session-query` |
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
Harniverse groups downstream package manifests by complete capability family rather than presenting each package as an independent capability.

| Capability | Service Definition | Service Provider | Consumer | Current downstream status |
|---|---|---|---|---|
| Inbound authentication and authorization | `dsh-authentication` (new) | `dsh-authentication-local` (new) | `dsh-client-connection` (official, modified), `dsh-auth-app` (new management bundle), `dsh-sdk-client` (official, modified) | Complete seam; public-key Grants produce short credentials bounded by Grant deadlines, human-readable enrollment is bounded, loss of the final owner seals every business transport, declared Host/Origin trust precedes authentication, endpoint metadata defaults unknown operations to deny, and concurrent admissions share durable registry and audit I/O without merging per-request decisions or records. |
| Outbound notification | `dsh-notification` (new; Definition + coordinator Consumer) | `dsh-notification-http` (new) | Coordinator folded into `dsh-notification` | Complete opt-in seam following the official session-telemetry pattern. |
| Durable result artifacts | `dsh-spill` (official, modified) | `dsh-spill-local` (official, modified) | `dsh-tool-result-artifacts` (new), `dsh-spill-policy` | Complete seam; one Consumer owns retention, recovery marker, failure semantics, and `artifact_read`. |
| Recallable and model-directed compaction | `dsh-compaction` (official, modified) plus `dsh-compaction-lossless` summary-DAG service (new) | `dsh-compaction-lossless` (new; inherits the official basic Provider transaction) | `dsh-tool-compaction` (new), `dsh-tool-compaction-history` (new) | Complete shipped seam; automatic and direct model-requested compaction share the Provider transaction and committed checkpoints over the canonical Session log, while bounded current-session tools search summaries and expand parent/source history. |
| Read-only plugin diagnostics | `dsh-plugin-diagnostics` (new) | `dsh-plugin-diagnostics-cordis` (new) | `dsh-host-plugin-inventory`, `dsh-api-remotes`, `dsh-client-ui-settings-plugin-inventory` (official, modified) | Complete shipped advisory seam; effect-scoped checks observe Host Loader, standing preset, and dynamic Cordis lifecycle state, while the authorized Remote and existing Settings tab expose structured findings and textual hints without a repair operation. |
| Agent Profile plugin composition | `dsh-capabilities` (new; recipe/member catalog, typed override store, and planner) | `dsh-agent-presets` (official, modified; static recipe/config compiler and generation runtime), `dsh-host-capability-management` (new; authorized Remote) | `dsh-tools`, `dsh-skill`, `dsh-mcp-client` (official, modified), `dsh-client-ui-settings-capabilities` (new) | Complete composition seam for Tool, Skill, MCP-server, and Subagent-provider recipes; catalog reads mount no Profile, global/Profile selection, immutable-member allowlist, and owner-declared configuration inheritance drive native Loader patches and registry restrictions, hard dependencies auto-load, running Sessions stay pinned, and each live Session exposes its immutable generation and resolved members. |

### Added Packages

| Package | Role | Default composition |
|---|---|---|
| `@deepseek-ai/dsh-authentication` | Inbound authentication Service Definition | Type/service dependency; the concrete Web row loads its Provider. |
| `@deepseek-ai/dsh-authentication-local` | Local public-key Grant, challenge, Access Token, and browser-session Service Provider | Enabled by `dsh-web-app`. |
| `@deepseek-ai/dsh-auth-app` | One-shot authentication management bundle and Consumer | Shipped as the standalone `auth` profile; `dsh auth` is its alias. |
| `@deepseek-ai/dsh-notification` | Notification Service Definition plus lifecycle projection Consumer | Not mounted alone. |
| `@deepseek-ai/dsh-notification-http` | Durable HTTP/HTTPS notification Service Provider | Opt-in examples only. |
| `@deepseek-ai/dsh-tool-result-artifacts` | Finalized-result retention and model-facing retrieval Consumer | Enabled in base/headless scopes and per-agent Web presets. |
| `@deepseek-ai/dsh-compaction-lossless` | Automatic compaction Provider plus committed summary-DAG projection | Enabled in base, the standalone headless example, and the standard, code, and Cordis presets. |
| `@deepseek-ai/dsh-tool-compaction` | Direct model-facing Consumer for one retained-tail compaction request | Enabled beside `dsh-compaction-lossless` in base, standalone headless, standard, and Cordis; omitted by minimal and Code presets. |
| `@deepseek-ai/dsh-tool-compaction-history` | Bounded current-session summary search and expansion Consumer | Enabled beside `dsh-compaction-lossless`; omitted by the minimal preset. The headless overflow snapshot pins its model-visible names and safety guidance. |
| `@deepseek-ai/dsh-plugin-diagnostics` | Effect-scoped read-only diagnostic registry and report coordinator | Enabled by `dsh-web-app` before diagnostic Providers and the Host Remote. |
| `@deepseek-ai/dsh-plugin-diagnostics-cordis` | Host Loader, standing preset, and dynamic Cordis diagnostic Provider | Enabled by `dsh-web-app`; contributes observations only and owns no repair operation. |
| `@deepseek-ai/dsh-capabilities` | Scoped recipe registry, inherited Agent composition, dependency planner, and generation selection coordinator | Enabled by `dsh-base`; registers no model-facing capability by itself. |
| `@deepseek-ai/dsh-host-capability-management` | Static Profile-recipe and Host-provider adapters plus authorized catalog/plan/apply/Session Remote | Enabled by `dsh-web-app`; observation requires `harniverse.observe`, mutation requires `harniverse.administer`. |
| `@deepseek-ai/dsh-client-ui-settings-capabilities` | Global/Profile assembly editor, plan preview, and read-only Session capability view | Enabled by `dsh-web-app` as a Plugins Settings tab and conversation view. |

### Modified Official Plugin Families

| Area | Official packages changed by Harniverse |
|---|---|
| Model and Web defaults | `dsh-base`, `dsh-web`, `dsh-web-search-exa`, `dsh-web-search-perplexity`, `dsh-client-ui-settings-models`, `dsh-client-ui-settings-plugins` |
| Session control and reconnect | `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-host-apiproxy`, `dsh-client-connection`, `dsh-client-runtime`, `dsh-session-persistence`, `dsh-session-persistence-jsonl`, `dsh-session-persistence-sqlite`, `dsh-session-projection-cache`, `dsh-workspace` |
| Agent Profile identity and composition | `dsh-agent-presets`, `dsh-host-apiproxy`, `dsh-permission-presets`, `dsh-client-runtime`, `dsh-client-ui-agent-preset`, session persistence/query Providers, and in-process subagent composition |
| Result retention and bounded file access | `dsh-tools`, `dsh-spill`, `dsh-spill-local`, `dsh-spill-policy`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`, `dsh-client-ui-tool`, `dsh-compaction`, `dsh-token-meter` |
| Compaction composition, proactive trigger, and recall | `dsh-compaction`, `dsh-compaction-basic`, `dsh-base`, `dsh-web-app`, and the standalone headless example; standard and Cordis Agent presets select both model Consumers, while Code keeps automatic compaction and recall without the direct-only trigger. |
| Authenticated Web and automation surface | `dsh-web-app`, `dsh-client-connection`, `dsh-client-modules`, `dsh-client-hmr`, `dsh-client-web`, `dsh-host-webserver`, `dsh-sdk-client`, `dsh-api-gateway`, `dsh-typert-protocol`, `dsh-typert-generator`, `dsh-typert-loader`, `dsh-typert-registry` |
| Derived runtime catalogs | `dsh-cordis-client-runner`, `dsh-tool-cordis` |
| Test support projection | `dsh-acp-snapshot` normalization only |
| Plugin operations and diagnostics | `dsh-host-plugin-inventory`, `dsh-api-remotes`, `dsh-client-ui-settings-plugin-inventory`, `dsh-web-app` |
| Agent Profile capability composition | `dsh-agent-presets`, `dsh-tools`, `dsh-mcp-client`, `dsh-cordis-host-runner`, `dsh-tool-cordis`, `dsh-api-remotes`, `dsh-web-app` |
| Shared workspace storage compatibility | `dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`, `dsh-storage-sqlite`, `dsh-workspace` |
<!-- capability-changes-end -->

## Shipped Composition Changes

<!-- composition-changes-start -->
| Composition surface | Current Harniverse change |
|---|---|
| `dsh-base` model adapters | Native `dsh-llm-deepseek` remains installed but defaults disabled; official `dsh-llm-pi-ai` is the enabled vendor-neutral adapter. |
| `dsh-base` Web providers | Existing Exa and Perplexity providers are mounted beside DeepSeek; provider selection is live settings-backed. |
| `dsh-base` model Web tools | `dsh-tool-web` remains loaded with both search and fetch disabled by default. |
| `dsh-base` result policy | Legacy `dsh-spill-policy` and `dsh-compaction-tool-result-pruner` rows default disabled; `dsh-tool-result-artifacts` handles finalized-result retention and `artifact_read`. |
| `dsh-base` compaction | `dsh-compaction-lossless` replaces the official basic row while inheriting its automatic transaction policy; `dsh-tool-compaction` exposes one direct retained-tail request and `dsh-tool-compaction-history` exposes bounded recall. Web moves the Provider and history Consumer behind standard, code, and Cordis Agent presets, and moves the direct-only Consumer behind standard and Cordis; minimal remains uncompacted. |
| Standalone headless example | The runnable headless composition selects the same lossless Provider, proactive Consumer, and history Consumer; its keyless overflow snapshot verifies committed replacement plus model-visible recall tools and untrusted-history guidance. |
| `dsh-web-app` authentication | `dsh-authentication-local` initializes before WebServer bind; connection injects the provider-neutral service. |
| `dsh-web-app` transport | Non-loopback listeners require direct TLS; authentication bypass is loopback-only. The Web startup provider carries explicit Host and exact-Origin trust into `dsh-client-connection`, while the composition prints the effective trust policy and mounts the Cordis console exporter for privacy-minimal connection and authentication diagnostics. |
| `dsh-web-app` client plugin delivery | Initial browser boot registers every independent plugin factory through one revision-addressed, gzip-capable `/plugins/bootstrap.js` resource; per-plugin scripts and source maps remain available for aggregate fallback and HMR, preserving the plugin-native Loader/fiber lifecycle. |
| Source container/Tailscale launcher | `pnpm run web:container` persists a development CA and leaf certificate under `$DSH_HOME`, maps certificate SAN hosts to the same authenticated Web profile's Host trust, optionally carries exact advanced Origins, and leaves browser enrollment and owner approval intact; it is not a separate profile or plugin composition. |
| `auth` profile | `dsh-auth-app` parses device, Grant, and API-client management arguments inside the plugin tree and exits without mounting an Agent, WebServer, or authentication runtime Provider. |
| Notification | No shipped bundle mounts `dsh-notification-http`; explicit examples compose Storage plus the Provider. |
| `dsh-web-app` plugin diagnostics | Mounts the diagnostics registry and Cordis lifecycle Provider before the existing authorized plugin-inventory Remote; the existing Plugins Settings tab displays each current report without repair controls. |
| `dsh-base` Agent capability composition | Mounts the generic recipe/member composition registry; global Agent structured overrides inherit into Profile values, while source YAML rows supply native selection, member, and configuration defaults. |
| `dsh-web-app` capability management | Mounts the authorized recipe/member Remote, a Profile Assembly Settings tab, and a read-only Session Capabilities view. Catalog reads parse Profile files and discover Skills without starting a Profile. The next standing generation compiles selection and owner-declared configuration into Loader patches, applies Tool/Skill/MCP member allowlists through native registries, and records resolved members; running Sessions stay pinned, Host-shared MCP connections remain live, compatible read-only Cordis Inspect providers hold shared generation leases, and shared Subagent providers remain read-only. |
| `dsh-workspace` storage | Keeps the shared `workspace` domain at official DSH version 2, isolates the Harniverse-only deletion journal in `workspace_deletion` version 1, and explicitly migrates legacy version 3 workspace media. |
| `dsh-tool-todo` continuation | Optionally queues a plugin-attributed next-turn user message at `agent/turn-stopping` while the latest TODO snapshot remains unfinished, with a consecutive-turn cap and competing-input suppression. |
| Cross-session query and delivery | Separates current-title/creation/raw-activity discovery from content search, adds runtime status, folded-message tails, complete raw-log tails and windows, and keeps cwd as an optional filter rather than exact-target authority. A separate ordinary-session delivery Definition, local Provider, and Consumer own non-waiting `session_send_message` plus safe idle-only `session_unload`. The shared base mounts the Provider and model Consumers; Web Agent Profiles mount the Consumers in their own scopes, and indexed discovery/search opens lazily on first use. |
| Web Agent Profiles | `session.create({ agentProfile })` creates a distinct Agent instance with immutable durable Profile identity. Profile metadata selects the pre-publication permission preset; resume, fork, cold presentation, delivery, child inheritance, and browser summaries preserve the same identity. The four shipped Profiles default to `workspace-write`, and no Profile-switch method remains. |

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
| `6ba41ae8ef` | Replaces named-token inbound authentication with plugin-native public-key Enrollment/Grant/Access lifecycle, capability-total endpoint enforcement, bounded enrollment and per-Grant credentials, browser/API-client flows, and sealed owner admission. |
| `22c9c1b9a9` | Adds automatic lossless-style compaction over a committed summary DAG, bounded current-session history tools, and shipped bundle, preset, and headless composition. |
| `827dc083d5` | Adds the read-only plugin diagnostics Definition, Cordis Provider, authorized Remote projection, and Plugins Settings report. |
| `955ab7323a` | Adds the source container TLS launcher, Tailscale Host/SAN wiring, exact Origin trust configuration, human-readable enrollment errors, and privacy-minimal Web connection and authentication diagnostics. |
| `5158dec7a0` | Keeps the shared workspace domain compatible with official DSH, isolates Harniverse deletion recovery state, and migrates legacy workspace media explicitly. |
| `5816aa6d30` | Adds optional TODO-driven continuation turns with a bounded consecutive-turn policy and competing-input suppression. |
| `093c319309` | Adds cross-session ID-bound query, runtime status and message tails, ordinary-session message delivery with cold resume, and safe idle-only unload. |
| `baafb40c0d` | Makes Agent Profile identity immutable at Session creation, applies Profile default permissions before publication, and removes blank-Session Profile switching. |
| `7e38080de9` | Mounts cross-session query and delivery in shipped compositions, with Profile-scoped Web Consumers and lazy first-search SQLite activation. |
| `b2016ed5f2` | Adds current-title, creation-time, and raw-activity session discovery plus complete raw-log tail and window reads while preserving content-search hit semantics. |
| `995b34867c` | Adds inherited Agent Profile capability composition, static recipe planning, immutable Session generations, Host-shared MCP restrictions, and Web management/read-only runtime views. |
| `1dfeaaaea5` | Adds Profile-level Tool, Skill, and MCP member allowlists, owner-declared Persona configuration, native registry enforcement, and immutable generation member projections in the Web UI. |
| `44956e699b` | Batches concurrent authentication admissions and registers initial browser plugin factories through one revision-addressed aggregate while preserving independent fallback and HMR. |
| `8719eabfa4` | Adds direct model-requested retained-tail context compaction through the existing Provider transaction and lossless summary DAG. |
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
