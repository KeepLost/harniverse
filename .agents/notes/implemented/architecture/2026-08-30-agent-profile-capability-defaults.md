# Agent Note: Shipped Agent Profile capability defaults

Status: implemented

English | [中文](2026-08-30-agent-profile-capability-defaults.zh.md)

## Problem

The shipped Profile roster did not express one consistent capability policy. Minimal carried helper and persistent-session tools that were outside its evaluation purpose, while Standard-family Profiles did not activate the user extensions and Web capabilities their product contract described. User configuration also lacked a plugin-native path for multiple MCP servers and dialect-specific Hook discovery.

## Decision

The four shipped Agent Profiles have distinct model-facing contracts:

| Profile | Contract |
|---|---|
| Minimal | POSIX `bash` or Windows `pwsh`, plus `str_replace_editor`; no model-facing Skills, MCP, Hooks, persistent context, Web, subagent, artifact, history, or direct-compaction controls. |
| Standard | First-party coding, context, task, workflow, Web, Skills, Hooks, and MCP capabilities, excluding Cordis custom capabilities and `run_code`. |
| Code / PTC | Standard's logical capabilities presented through `run_code`, excluding Cordis custom capabilities. |
| Cordis / 创造 | Standard plus Cordis runtime inspection, plugin experimentation, and preset-authoring capabilities. |

Standard remains the default, and all four Profiles remain user-customizable through Profile composition and capability selection.

## Minimal recovery

Minimal mounts the lossless compaction Provider and its internal summary-DAG projection. Context pressure can therefore trigger runtime-owned compaction, but the model receives no compaction command, history query, session query, or delivery tool. The model-facing roster remains exactly the platform shell and `str_replace_editor`.

## User extensions

Standard, Code, and Cordis mount the existing filesystem Skill discovery and Skill tool, so user and project Skills are actively loaded and their catalog is disclosed by default. Existing capability member restrictions can disable individual Skill entries; a disabled entry is absent from the model-facing catalog. No Skill-specific read ACL is added.

The same Profiles mount both Hook dialect bridges. Without an explicit `configPath`, each bridge reads a fresh immutable snapshot for every event. Defaults include the dialect-specific user file under `$DSH_HOME/hooks` and the dialect-specific project file under `.dsh/hooks` in the session cwd. Generic `user`, `project`, `plugin`, and `policy` source lists can override individual defaults, and `disabled: true` or `enabled: false` omits a Hook group or command. Minimal does not mount either bridge.

The base composition owns one `mcp` settings Provider. Standard, Code, and Cordis each mount a scoped user-config consumer that reads `$DSH_HOME/settings.yaml`, creates one real `mcp-client` child per enabled server, actively discloses discovered namespaced tools, and isolates child failures and disposal. Disabled entries create no child or tools. Separate Profile consumers may expose the same configured public namespace through an internal reservation owner key; direct duplicate MCP rows retain their existing load-time rejection. Minimal does not mount the consumer.

## Web fetch

Standard, Code, and Cordis explicitly expose `web_search` and `web_fetch`. The local HTTP fetch Provider validates protocols and URL credentials, rejects non-public literal and resolved addresses, checks every DNS answer, pins the direct Node connection to a validated address while preserving Host/SNI, rejects redirects, and keeps bounded response decoding. `maxRedirects` is fixed at zero. Firecrawl fetch remains opt-in; the shipped base uses Firecrawl for search only, so it cannot bypass the local public-target policy through a provider argument. Minimal does not mount model-facing Web tools.

## Permission posture

The supported permission modes remain `read-only`, `workspace-write`, and `danger-full-access`. This implementation does not add a global extension-directory read ACL, change Skill loader read paths, or split read, execute, and network permissions into new controls. The existing single-tenant filesystem posture remains authoritative: readable paths are readable subject to the process and operating-system boundary, while write policy remains owned by the sandbox.

## Verification

The shipped Web Loader composition proves the Profile matrix, active user MCP discovery and disclosure, dialect-specific Hook discovery, Minimal exclusion, and Code SDK presentation. Hook parser and bridge suites cover source defaults, per-session cwd, immutable refresh, isolated failures, and disabled entries. MCP suites cover settings ownership, multiple child lifecycle, failure isolation, disabled entries, secret redaction, and separate Profile consumers. Web fetch tests cover public-address policy, DNS answer validation, direct transport, redirect rejection, response bounds, and real tool integration through a test-only loopback seam. Package type checks, lint, build, and keyless assembled tests remain required before delivery.

## Alternatives considered

**Keep the old Minimal composition.** This would preserve persistent shell state and helper tools, but would make a capability-evaluation Profile depend on context controls and session services that it is meant to exclude.

**Mount user MCP and Hook integrations in the base composition.** This would simplify discovery for Standard-family Profiles, but would leak model-facing extensions into Minimal and collapse Profile-scoped ownership. The shipped design keeps the MCP settings provider in base and its consumers in the selected Profiles, while Hook bridges remain Profile rows.

**Enable Firecrawl as the default fetch provider.** The remote provider can fetch arbitrary model-supplied URLs without the local public-address policy. The shipped base therefore keeps Firecrawl fetch opt-in and exposes the hardened direct HTTP provider for the default fetch path.

## Consequences

Active user extension disclosure increases request schema and context size and may expose poorly described user commands. MCP stdio servers and Hook commands remain trusted external processes; failure isolation is not a sandbox. Generic Hook discovery does not claim unverified product-specific paths or a trust/approval layer. The all-path read posture is intentional for the single-tenant deployment and is not a group-chat isolation strategy; a future remote execution provider is a separate decision.

This note supersedes the shipped-roster note's MCP dependency-only and fetch-disabled defaults, and the Web portions of the earlier Minimal persistent/bare/no-compaction notes. The standalone JSON-RPC example keeps its separate process-owned composition until a dedicated decision changes it.
