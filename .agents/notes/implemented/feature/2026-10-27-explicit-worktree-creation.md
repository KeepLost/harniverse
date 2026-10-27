# Agent Note: Explicit worktree creation

Status: implemented

English | [中文](2026-10-27-explicit-worktree-creation.zh.md)

## Problem

A task that needs to modify a project without disturbing the caller's checkout had no first-class path: `git worktree add` through the shell works but is invisible to the session's directory state, so every subsequent relative path, instruction discovery, and prompt statement still pointed at the original checkout, and uncommitted caller state risked interleaving with the task's edits.

## Decision

`dsh-worktree` (`ctx.worktrees`) creates one retained worktree per call: a fresh branch plus checkout pinned to a locally available commit, branch, or tag — no fetch, existing names refused — allocated into a configurable pool inside the source repository (`.agents/worktrees` by default, self-ignored by a generated `.gitignore`), then entered through the working-directory owner so the session's effective directory, notices, and consumers follow it.

Every command runs through the mounted subprocess runtime under the calling session's sandbox policy with cleared `GIT_DIR`-family selectors, `GIT_TERMINAL_PROMPT`/`GIT_LFS_SKIP_SMUDGE`/`GIT_NO_LAZY_FETCH`, per-command deadline, termination grace, and bounded capture. Directory allocation runs as a static Node child so pool creation honors the same confinement. Checkout disables configured clean/smudge/process filters through command-local `GIT_CONFIG_*` overrides without touching Git configuration, and uses `--no-checkout` plus `reset --hard` so no filter runs during checkout. Traversal spellings are rejected independently of Git's branch grammar. Failures wrap the operation and explicitly retain whatever was created; nothing is ever removed automatically. `dsh-tool-worktree` exposes the `create_worktree` model tool over the service.

## Alternatives considered

**Shell-only worktrees.** Keeps the session directory state wrong for every other tool; the working-directory owner exists precisely to prevent that.

**Auto-managed worktree lifecycle.** Retention is deliberate: a failed or abandoned checkout is forensic evidence, and automatic removal races concurrent users of the pool.

**Checkout into a global temp pool outside the repository.** Breaks the sandbox workspace-root model: writes inside the repository stay within the session's `workspace-write` boundary, an outside pool would need new writable-root policy.

## Consequences

- The pool directory lives inside the source repository and is ignored by its generated `.gitignore`; deployments configuring a different pool own its ignore rules.
- Verification covers creation from HEAD and a pinned revision, filter disabling, sandbox-wrapped versus unconfined execution, existing branch/path and traversal rejections, non-repository failure, wrapped partial-failure retention, configuration validation, disposal, and the Loader-mounted composition end-to-end with a real repository.
