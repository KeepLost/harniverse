# @deepseek-ai/dsh-worktree

English | [中文](README.zh.md)

Creates retained Git worktrees under the mounted filesystem and sandbox providers (`ctx.worktrees`), then enters the new checkout as the calling session's working directory through the working-directory owner. A worktree is a fresh branch plus checkout pinned to a locally available commit, branch, or tag — no fetch is performed, and the created checkout and branch are deliberately retained: nothing is removed automatically, including after a failed creation.

## Behavior

`create(agent, { name?, from? })` validates the branch name as a relative Git ref (rejecting traversal spellings independently of Git's grammar), resolves the source repository from the session's current directory, pins the base commit (`from`, default `HEAD`), refuses existing branches and existing checkout paths, allocates the checkout pool under the configured relative `directory` inside the repository root (a self-ignoring `.gitignore` is written once by the process that first creates the pool), and checks out without running configured clean/smudge/process filters — filter drivers are disabled through command-local `GIT_CONFIG_*` overrides without changing Git configuration.

Every command runs through the mounted subprocess runtime under the calling session's sandbox policy: `GIT_DIR`-family environment selectors are cleared, `GIT_TERMINAL_PROMPT`, `GIT_LFS_SKIP_SMUDGE`, and `GIT_NO_LAZY_FETCH` are set, and each command carries a deadline, a termination grace, and a bounded output capture. The new checkout becomes the session's directory only after Git setup succeeds; a failure wraps the operation (`Could not finish worktree …`) and reports that any created artifacts are retained.

## Config

| Key | Default | Meaning |
|---|---|---|
| `directory` | `.agents/worktrees` | Relative checkout pool inside the source repository; must be relative without dot segments. |
| `namePrefix` | `worktree-` | Prefix for generated branch names; must produce a relative branch name. |
| `gitCommand` | `git` | Executable honoring `GIT_NO_LAZY_FETCH`; non-empty. |
| `nodeCommand` | `node` | Executable used for sandboxed directory allocation; non-empty. |
| `timeoutMs` | `60000` | Deadline for one command. |
| `graceMs` | `3000` | Subprocess termination grace. |
| `maxOutputBytes` | `65536` | Captured bytes per output stream. |

```yaml
- id: worktree
  name: '@deepseek-ai/dsh-worktree'
```

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-worktree`; the working-directory service's notice announces the entered checkout.

#### KV Cache effect

No direct invalidation; the entered-directory notice owns the single request-prefix change.

## Known Limitations and Deferred Work

- **Failures may retain partial artifacts** — an allocation that fails mid-flight leaves created branches or directories in place by design; retrying needs a new name.
- **The checkout pool lives inside the source repository** — the pool relies on the repository's own ignore rules (the generated `.gitignore` covers the default layout); a differently configured pool directory is the deployment's responsibility.
- **Repository-local replacement refs still apply** — `baseCommit` reports the resolved object name, whose checked-out content replacement refs can change.
