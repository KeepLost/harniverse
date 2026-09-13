# Agent Note: The governor global budget joins the settings panel through the existing settings scope

Status: implemented

English | [中文](2026-09-13-governor-global-quota-settings.zh.md)

## Problem

The governor enforces exactly one global quota — the memory budget — and its only human controls were editing `settings.yaml` by hand or the administer-gated `reload` Remote: both host-side actions, invisible to a user standing in front of the web GUI. The resource board shows the global budget bar but deliberately cannot move it; board writes are `harniverse.operate` session actions, and a global configuration change is not one. The [governor metering note](../architecture/2026-09-12-resource-governor-metering-and-quotas.md) left the human path at "settings or the administer-gated Remote"; the settings-panel surface for it was the delivery gap.

## Decision

### A settings section, not a board control

ui-governor registers `settings.section` id `governor` (ordered after the Plugins page — runtime governance follows host configuration). The page edits only the global memory budget: `auto` or a custom GiB figure. CPU, disk, and network are observation-only by design and carry no controls; sampling cadence and history persistence stay plain `governor:` settings fields with no dedicated UI here.

### Writes ride the client settings scope; the host keeps ownership of resolution

The page binds `ctx.settingsScope.bind({ namespace: 'governor' })`; an apply is one `memory.limit` `set` op through `settings.mutate`, so the settings domain's `harniverse.administer` gate and revision check authorize the write, and an identity without the capability gets the read-only or unavailable copy rather than a disabled illusion. The host side gains no new write path: the governor service's existing `installSettingsSection` hook re-resolves and re-applies the budget on change (`applyGlobalLimit` — parent cgroup then leaves), hot and without restart. The effective budget shown beside the form is read back through `configGet`, because resolution is a host fact — `auto` is 80% of the smaller of physical memory and the host's own cgroup ceiling, with a fallback budget when host facts are unreadable — and the page rereads immediately and once more 600 ms later to cover the asynchronous apply. No budget arithmetic is computed client-side.

### Session quotas and swap stay where they were

Session-level quotas inherit the global budget by default and remain per-session decisions — the agent's `resource-quota` tool or the board's inline negotiation — with no preset fields: a quota is an admission-controlled runtime decision tied to one session's life, not composition-time configuration. The cgroup tier pins `memory.swap.max` at 0; the rlimit tier sets no swap limit.

## Alternatives considered

- **A budget editor on the board, beside the budget bar** — rejected: board writes are `harniverse.operate` session actions, and the budget is durable host configuration; an administer-class global write behind an operate-gated affordance puts the wrong capability behind the wrong seat.
- **A dedicated governor Remote write verb** — rejected: the settings domain already owns durable config writes (`settings.mutate`, administer-gated, revision-checked, mirrored and redacted); a second write path would bypass the settings mirror's principal-generation fence. `configGet`, already shipped for the board's tier display, covers the read side.
- **Calling `reload` from the page after writing settings** — rejected: `installSettingsSection`'s onChange already re-applies the budget hot; `reload` stays the manual escape hatch for out-of-band edits to `settings.yaml`.
- **Session quota fields in the agent preset** — rejected: presets own which capabilities a session is composed with, not how much memory it may use; a quota raise passes admission against the live global budget, which a static preset cannot promise.

## Consequences

- A user holding `harniverse.administer` can move the one enforced global quota from the web GUI; the write lands in the `governor:` settings section of `settings.yaml` and applies without a restart.
- The capability split matches the write each surface performs: the board stays operate-gated and session-scoped; the settings page is administer-gated and global.
- The page displays host-resolved truth only (`configGet`); client-side budget arithmetic cannot drift from host resolution.
- The governor metering note stays active and cross-linked above; this note extends its human-surface story and changes nothing of its tier model.
- Package specs cover the settings page (scope-seeded mode and draft, explicit-budget and return-to-`auto` writes through the scope, non-positive rejection, read-only and unavailable arms, failed effective read) and the browser half's registration set (inject list, `settings.section` entry and teardown, `configGet` binding).
