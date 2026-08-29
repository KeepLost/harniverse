# Agent Note: Agent Profile capability defaults and user extension disclosure

Status: rejected — superseded by the shipped implementation note

English | [中文](2026-08-29-agent-profile-capability-defaults.zh.md)

## Problem

The four shipped Agent Profiles do not yet express their intended product roles. Minimal carries helper capabilities that are not part of a controlled model-capability evaluation, while Standard-family Profiles do not make user-owned Skills, Hooks, or MCP servers a first-class default. The shipped Web tool configuration also keeps HTTP fetch disabled because its provider does not yet enforce the required target boundary.

The existing [shipped tool-roster decision](../../implemented/feature/2026-07-31-even-out-shipped-tool-rosters.md) records the earlier common roster, the dependency-only MCP integration, and the disabled fetch posture. This proposal deliberately supersedes those parts when the corresponding implementation lands; the unrelated surface-roster and tool-ownership decisions remain authoritative.

## Proposal

This proposal was superseded by the shipped implementation recorded in [Shipped Agent Profile capability defaults](../../implemented/architecture/2026-08-30-agent-profile-capability-defaults.md).

### Profile roles

The shipped Profiles use four distinct capability contracts:

| Profile | Model-facing contract |
|---|---|
| Minimal | `bash` on POSIX or `pwsh` on Windows, plus `str_replace_editor`; no model-facing Skills, MCP, Hooks, persistent context, Web, subagent, artifact, history, or direct-compaction controls. |
| Standard | The first-party coding, context, task, workflow, Web, Skills, Hooks, and MCP capabilities, excluding Cordis custom capabilities and `run_code`. |
| Code / PTC | Standard's logical capability set presented through `run_code`, without Cordis custom capabilities. |
| Cordis / 创造 | Standard plus Cordis runtime inspection, plugin experimentation, and preset-authoring capabilities. |

Standard remains the default Profile. All four Profiles remain user-customizable through the existing Profile composition and capability-selection mechanisms.

### Minimal compaction

Minimal loads the automatic compaction Provider and its internal summary-DAG projection. When context pressure requires recovery, the runtime forces compaction without exposing a compaction Tool or timing choice to the model. Minimal does not mount direct compaction, compaction-history, session-query, or cross-session delivery Consumers. Its internal Session log and summary DAG remain available to the runtime for current-context reconstruction; no model-facing history API is implied.

### User-owned extensions

Standard, Code, and Cordis automatically discover and load user-configured global Skills, Hooks, and MCP servers. Their default model-facing behavior is active disclosure: discovered Skills contribute their catalog and discovered MCP servers contribute their namespaced tool definitions to the model request. Users may disable individual configured entries; a disabled Skill or MCP entry is absent from the model-facing disclosure, and a disabled Hook is not active.

The Skill provider continues to read its existing project, user, custom, and bundled roots. Global Skill directories do not receive a new ACL or special filesystem capability. They are readable under the same all-path read behavior already provided by the selected process and operating-system permissions. This proposal changes discovery and disclosure defaults, not filesystem read policy.

MCP configuration is user-owned and may describe multiple server instances. A composition bridge reads the configured list and creates one MCP client instance per entry, preserving the existing server-qualified tool names and connection lifecycle. Minimal does not load or disclose user MCP entries.

Hook discovery covers project, user, plugin, and policy configuration layers and refreshes the active set when supported configuration changes. Hook policy remains an interception, audit, and redaction mechanism; it is not an absolute guarantee against secret disclosure under broad process, filesystem, or network access.

### Web fetch

Standard, Code, and Cordis mount the model-facing Web search and fetch capabilities after the HTTP provider rejects unsafe protocols, credentials, loopback and private targets, metadata endpoints, invalid resolved addresses, and unsafe redirects according to one bounded request policy. Minimal does not mount model-facing Web capabilities. Network-level egress controls remain a deployment responsibility.

### Permission posture

The three permission modes remain `read-only`, `workspace-write`, and `danger-full-access`. This change does not add a global extension-directory read ACL, alter Skill loader read paths, or split read, execute, and network permissions into new independent controls. Under the existing single-tenant posture, readable paths remain readable subject to the process and operating system boundary.

## Alternatives considered

**Keep Minimal as a reduced Standard composition.** Rejected because evaluation needs a deliberately small model-facing contract, not a Standard tree with hidden or incidental context and recovery tools.

**Load user Skills and MCP but withhold their default disclosure.** Rejected because Standard's purpose is to make configured user capabilities immediately available to the model. The user can disable individual entries when they should not be disclosed.

**Keep MCP as a dependency without a user-list bridge.** Rejected because that leaves configured MCP servers outside the shipped Standard-family default even though the MCP client already supports the required per-server lifecycle.

**Add a special read permission for global Skill directories.** Rejected because current sandbox and filesystem semantics intentionally allow reads across readable paths in the single-tenant deployment. A second read policy would not protect the intended threat model and would complicate the permission contract.

**Enable HTTP fetch before strengthening target validation.** Rejected because a model-selected URL is an SSRF primitive until protocol, resolution, target, redirect, and response handling are enforced by the provider boundary.

**Treat Hooks as a complete secret-leak prevention boundary.** Rejected because alternate commands, child processes, encodings, and network paths can bypass any finite Hook rule set. Hooks remain defense in depth rather than the sole isolation mechanism.

## Acceptance criteria

- The four assembled Profiles expose the exact model-facing capability contracts above, including Minimal's platform-specific shell and hidden internal compaction.
- Standard, Code, and Cordis load user Skills, Hooks, and MCP entries by default; individual disabled entries are absent from the relevant active or model-facing set.
- Global Skill discovery and loading continue to use the existing filesystem semantics without new read ACLs or path restrictions.
- Minimal has no model-facing Skill, MCP, Hook, persistent-context, history, direct-compaction, Web, subagent, artifact, or other context-control Tool.
- The HTTP fetch provider rejects unsafe targets and redirects, and the assembled Standard-family Web Profiles expose only the hardened fetch behavior.
- Profile composition, Skill, MCP, Hook, Web-policy, keyless snapshot, built Web, and real runnable entry-point tests cover the defaults and opt-outs.

## Risks

User-provided MCP servers and Hooks can fail during discovery or activation and may run outside the local shell sandbox, so startup and refresh must isolate failures and report actionable diagnostics. Active global disclosure increases prompt and tool-schema size and can expose poorly described user extensions to the model. Web target validation must remain aligned with DNS, redirects, proxy behavior, and deployment networking. The deliberate all-path read posture remains unsuitable for an untrusted multi-user deployment; a future remote execution boundary is a separate deployment decision and is outside this proposal.
