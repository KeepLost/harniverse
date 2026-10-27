# @deepseek-ai/dsh-tool-worktree

English | [中文](README.zh.md)

Model tool for creating and entering a new Git worktree through the shared runtime (`ctx.worktrees`): `create_worktree` creates a fresh branch and checkout from a local commit, branch, or tag, then changes the session's working directory to it. Defaults are `HEAD` and a generated unique name; uncommitted files stay in the source checkout; existing names fail. Leaving the checkout later is `working_directory` with `cd` — the checkout and branch remain. It is a function plugin (`inject: ['tools', 'worktrees']`).

## Use

```yaml
- id: tool-worktree
  name: '@deepseek-ai/dsh-tool-worktree'
```

The base composition mounts the service and this tool; Web and preset compositions scope model visibility through their preset rows.

## Model Experience

Indirectly, through `dsh-worktree` and the working-directory notice that announces the entered checkout.

#### KV Cache effect

None directly; the entered-directory notice owns the single request-prefix change.

## Known Limitations and Deferred Work

- **Agentless calls fail** — the tool requires a calling agent session; non-agent callers get a tool error.
