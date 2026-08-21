# @deepseek-ai/dsh-host-capability-management

English | [中文](README.zh.md)

Authorized Host projection of Agent Profile composition. `CapabilityManagementGateway` registers the static Profile-recipe and Host Subagent-provider adapters and exposes `catalog`, `plan`, `apply`, and live-Session `session` reads through generated Typert Remotes. Catalog and Session reads require `harniverse.observe`; planning and application require `harniverse.administer`.

Catalog reads parse healthy Profile YAML files and discover filesystem Skills from the target Profile row's native roots without mounting a Profile. Every target receives one deployment-wide top-level recipe set, while each Profile's source rows supply its native selection, member, and configuration defaults. The planner produces revision-fenced selection, member-allowlist, and typed-configuration operations plus dependency blockers. The Session endpoint returns the immutable generation id, resolved members, and loaded, not-loaded, failed, dependency-blocked, or security-denied results captured before publication.

## Model Experience

Indirectly, through applied composition that changes which Profile plugin rows exist in future generations while existing Sessions retain their original generation.

#### KV Cache effect

None on its own. Compositions applied through this Gateway can change the visible definitions and reusable prefix of new Sessions.

## Known Limitations and Deferred Work

- **Live Session reads** — a cold persisted Session has no process-local generation to inspect until it resumes.
- **Host providers remain read-only** — process-global Subagent providers are reported as Host-provided; Profile delegation is assembled through its selectable Profile plugin group.
