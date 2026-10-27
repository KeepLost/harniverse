# @deepseek-ai/dsh-tool-working-directory

English | [中文](README.zh.md)

Model-facing `working_directory` tool over the session working-directory service (`ctx.workingDirectory`): read the current directory, or change it with `cd`. Relative paths resolve against the current directory. Existing shells and running processes keep their own directories. It is a function plugin (`inject: ['tools', 'workingDirectory']`).

## Use

```yaml
- id: tool-working-directory
  name: '@deepseek-ai/dsh-tool-working-directory'
```

The base composition mounts the service and this tool; Web and preset compositions scope model visibility through their preset rows. Omitting `cd` validates and returns the current directory (recording the implicit start on first use); providing it commits a durable `working-directory/change` and queues the model-visible notice. Failures surface as ordinary tool errors naming the missing directory.

## Model Experience

Indirectly, through `dsh-working-directory`, whose notice and context own the durable record.

#### KV Cache effect

None directly; the owning service's notice and context own any request-prefix changes.

## Known Limitations and Deferred Work

- **Agentless calls fail** — the tool requires a calling agent session; non-agent callers get a tool error.
