# Agent Note: Skills load unconditionally with recursive discovery

Status: implemented

English | [中文](2026-09-26-skills-unconditional-visibility.zh.md)

## Problem

The skill invocation policy (`SkillInvocationPolicy` with `modelInvocable`/`userInvocable`, driven by `disable-model-invocation` and `user-invocable` frontmatter) split one discovered catalog into four quadrants that no shipped composition actually used: every repository skill except `dsh-translate-docs` was fully invocable, the capability catalog derived `defaultVisible` from the policy, the api-proxy wire required `modelInvocable` on every entry, and the SSH consumer validated the policy over the wire. The gate was surface area with no consumer. Separately, discovery only recognized `<root>/<name>/SKILL.md` and root-level `<name>.md`, so nested organizations of a skill tree were invisible.

## Decision

Both were removed or widened together, accepting the wire break (RC, no compatibility commitment):

- `SkillInvocationPolicy`, `isModelInvocable`, `isUserInvocable`, the `invocation` field on summaries/candidates/definitions/registrations, and all validation are deleted from `dsh-skill`. Every discovered skill is model- and user-invocable; `dsh-tool-skill`'s catalog and `skill` tool list everything, and the user-explicit `/name` gesture path is unchanged apart from dropping the policy check.
- The local filesystem provider rejects the removed frontmatter keys (`disable-model-invocation`, `user-invocable`, and camelCase spellings) at parse time with a warn-and-skip, so a stale policy file fails loud instead of silently misloading.
- Discovery recurses: `SKILL.md` at any depth under a root is found, never entering hidden directories, `node_modules`, or `.git`, bounded to ten levels with a symlink-cycle identity set. Root-level flat `<name>.md` files remain a root-only form. A directory *named* `SKILL.md` is still probed as a skill file so the malformed bundle fails loud (incomplete discovery), preserving the pre-recursion behavior. Watcher relevance follows the recursive rule.
- Consumers follow: the capability catalog defaults skill members visible; the api-proxy `skill.list` wire drops `modelInvocable`; `ui-skill` drops the user-only description marker and its locale key; the SSH `machine.skill` response shape drops the policy; the bundled badge candidate carries no policy; `scripts/verify-skill-invocation-metadata.ts` and its gate entry are deleted; `type-equiv`, `api-catalog`, and the skills subsystem doc (en+zh) are regenerated.
- `dsh-translate-docs` keeps its location and loses its hiding frontmatter: its own SKILL.md invocation-boundary section and the repo AGENTS rule ("only explicit user invocation") govern it, exactly like its ten sibling skills. Moving it out of the default roots was rejected because that would make the documented workflow unreachable.

This supersedes the 2026-07-28 skill invocation policy note, which stays as history.

## Alternatives considered

**Keep the policy as dormant surface.** Rejected: four quadrants with zero shipped consumers is maintenance cost on every future skill feature — the catalog, wire, SSH, and badge surfaces each carried policy plumbing this change deleted.

**Move `dsh-translate-docs` out of the default roots.** Rejected: the skill is a documented, explicitly-invoked workflow; hiding it from discovery would make it unreachable rather than merely invisible.

## Consequences

One catalog serves every surface; a skill bounds its own use in prose instead of frontmatter. Sessions replaying old logs with policy-bearing replay data are unaffected (the policy lived on candidates, not on durable session content). Wire consumers of `skill.list` see a smaller entry shape. Nested skill trees under any root now load, and `node_modules`/`.git`/hidden directories are never scanned, so accidental deep trees stay bounded.

## Testing

`pnpm exec vitest run packages/skill packages/host/capability-management packages/host/apiproxy packages/client/ui-skill packages/ssh/ssh packages/client/connection` — 723 tests including new coverage for recursive discovery (nested bundles, skipped directories, depth files), rejected frontmatter keys, the uniform catalog, and the reworked policy-free fixtures. The ACP `skill-load` snapshot fixtures document the uniform catalog and are refreshed with the golden replay pass.
