# @deepseek-ai/dsh-client-ui-settings-capabilities

English | [中文](README.zh.md)

Localized **Profile assembly** tab for Web Settings plus a read-only **Capabilities** Session view. The Settings tab reads the Agent Profile roster and authorized capability-management Remote only after mounting. Every target shows the same deployment recipe set; users stage `inherit`, `load`, or `unload` values for Tool, Skill, MCP-server, and Subagent-provider entries. Profile rows show the effective global selection they inherit.

Nothing is written when a selection control changes. **Preview impact** sends the complete draft to the Host planner and renders explicit plus automatically added dependency operations. **Save assembly list** remains disabled until the returned plan has no blockers, then submits only the plan id and expected revision. The Session view shows its immutable Profile generation and the actual loaded, not-loaded, failed, dependency-blocked, or security-denied result for each recipe.

## Model Experience

None, as this package only renders and edits Host-owned composition in the browser.

#### KV Cache effect

None in the browser plugin. A committed composition can change the reusable request prefix of new Sessions whose effective definitions differ.

## Known Limitations and Deferred Work

- **No live-session mutation** — the editor targets global defaults and Agent Profiles; the Session view is read-only so history and tool-call replay remain bound to one generation.
- **Cold Sessions have no runtime result** — a persisted Session must resume before the Host can report its process-local generation.
