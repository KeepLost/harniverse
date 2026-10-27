# Agent Note: Shared agents root joins the user-global instruction chain

Status: implemented

English | [中文](2026-10-27-shared-agents-root-instructions.zh.md)

## Problem

The instruction loader read one user-global file, `$DSH_HOME/AGENTS.md`. People running several agent tools keep the instructions shared across those tools in the shared agent configuration root (`~/.agents/AGENTS.md`, or `$DSH_AGENTS_HOME`) that `dsh-skill-filesystem` already scans for skills. Those instructions reached the harness only when copied or symlinked into the harness home — duplicating one source of truth into harness-owned data, with no way to tell which copy a session loaded.

## Decision

The user-global instruction scope has two ordered roots: `$DSH_HOME/AGENTS.md` first, then `<agentsHome>/AGENTS.md`. `resolveAgentsHome` and `agentsHomeDisplay` in `dsh-home-paths` own the resolution (configured value, then `$DSH_AGENTS_HOME`, then `~/.agents`, with tilde expansion and blank-environment handling identical to the harness home), so both `dsh-agent-instructions` and `dsh-skill-filesystem` resolve through one shared resolver.

The two files form one trimmed-content dedup group: an identical shared-root file (including through the common symlink layout) renders once, from the harness home, and is promoted when that retained copy changes or disappears — baseline dedup and dynamic reconciliation use the same group key. The harness-home file keeps the recorded `user-global` scope key; the shared file carries `agents-global`, so an external edit, removal, or newly created file appears as an ordinary transition instead of a new baseline. A project directory named `user-global` or `agents-global` keeps its own scope through a `./` display escape.

## Alternatives considered

**Replace the harness-home file with the shared root.** The harness home owns harness-specific configuration and its file is the documented, tested user-global layer; removing it drops a harness-only tier for anyone sharing instructions across tools.

**Load the shared root only when the harness-home file is absent.** The two files would alternate as the session-visible user-global file, silently suppressing instead of composing.

**Rely on path identity for the duplicate case.** The common layout symlinks the harness-home file at the shared root — two paths, one file — and identical distinct copies are the normal case; only trimmed-content identity handles both.

## Consequences

- Shared instructions load without a copy or symlink; `dsh-agent-instructions` exposes the symmetric `agentsHome` config field beside `dshHome`.
- Verification covers two-root order and labels, `$DSH_AGENTS_HOME` resolution with blank handling, cross-root baseline dedup and drift promotion, reconciliation removal/promotion transitions, and the reserved-name project-scope escape.
