# @deepseek-ai/dsh-subagent-oar

English | [中文](README.zh.md)

This package registers named one-shot subagent providers backed by the embedded [OAR](https://www.npmjs.com/package/@botiverse/oar) runtime registry. Each provider instance selects one OAR default runtime (today `codex` or `claude`); every accepted run opens a native OAR session in the delegating Session's workspace, submits one self-contained text task, and returns only the root assistant text through the shared [`dsh-subagent`](../subagent/README.md) result contract. Native records, credentials, and protocol detail stay inside the runtime.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It then probes the runtime's installation with the credential-scrubbed environment overlay, opens a native session with the configured model, effort, launch arguments, and environment, and publishes the run only after the session exists. A failure or cancellation before publication disposes the partially opened session; cancellation keeps precedence over every later failure classification.

The published `run.result` streams root `text_delta` events and settles exactly one native turn: the streamed text joined with the last non-empty identified root message wins, child-agent output and private reasoning are never surfaced, and a successful turn with an empty answer settles as an empty completed result. Local cancellation wins the result race and maps to `aborted`; a configured `timeoutMs` bounds the turn without depending on model cooperation and maps to `error`. Every non-completed result carries a safe diagnostic naming the fixed stage (`installation` / `startup` / `turn` / `abort` / `dispose`) and category plus one line of advice; native exception text is retained only on the private `cause` chain and in the Host log, never in the model-visible diagnostic.

`dispose()` is idempotent: it aborts the native session when interruption is still possible, disposes the OAR session, and awaits the same disposal from the run handle. Result failure and independent teardown failure remain separate, and a failing teardown never discards an already settled answer.

## Capabilities and context

The provider advertises no optional start-time capabilities and reports `inheritsParentContext: false`. The runtime receives the standalone text task, the parent Session cwd, and the configured environment overlay, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. Native session ids stay private to the run.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `runtime` | — (required) | OAR default-runtime id; unknown ids fail during plugin activation. |
| `providerName` | `oar` | Name registered on `ctx.subagents`. |
| `model` | runtime default | Native model id; omission preserves the runtime's model selection. |
| `effort` | runtime default | Native reasoning effort; unsupported choices fail at startup. |
| `env` | `{}` | Explicit entries applied after the subprocess seam's credential scrub; `null` removes an inherited value. |
| `launchArgs` | `[]` | Native process arguments, including permission settings; OAR validates arguments it owns. |
| `timeoutMs` | none | Optional turn deadline in milliseconds after startup, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md); omission relies on parent cancellation only. |

The embedded runtime declares `engines.node >= 24.0.0`; the provider refuses loudly during plugin activation on an older Host instead of failing inside native code. Credential-shaped ambient variables are removed by the shared scrub (`OAR_FIXTURE_API_TOKEN`-style secrets never reach the child), while ordinary ambient values such as `PATH` and `HOME` remain available unless overridden.

Compose the provider explicitly — shipped profiles and presets do not mount it. Two provider instances plus the selection tool form the documented composition (see the [worked example](../../../examples/acp-agent/tests/fixtures/subagent/subagent-oar/cordis.yml)):

```yaml
- id: subagent-oar-codex
  name: '@deepseek-ai/dsh-subagent-oar'
  config:
    runtime: codex
    providerName: oar-codex
    launchArgs: ['-c', 'sandbox_mode="workspace-write"']

- id: subagent-oar-claude
  name: '@deepseek-ai/dsh-subagent-oar'
  config:
    runtime: claude
    providerName: oar-claude
    launchArgs: ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']

- id: tool-subagent-oar
  name: '@deepseek-ai/dsh-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

## Product compatibility and evidence

The published artifact embeds the patched `@botiverse/oar@0.67.0` implementation (Apache-2.0; see `LICENSE-OAR`) and declares only the runtime's externalized dependencies — consumers never install or resolve the OAR package itself. The patch carries the Claude `--permission-mode` passthrough (replacing the unconditional `--dangerously-skip-permissions`), Codex client initialize-failure cleanup, and environment-overlay installation probes; `pnpm patch` applies it at development time and the bundling step bakes it into `lib/index.js`. Evidence: the scripted-runtime unit suite, the Loader composition smoke over the worked example, the environment-scrub and startup-cleanup fixture e2e, and the packed-artifact test proving the embedded patch and the absent external OAR resolution.

## Model Experience

### Child request

#### What the model sees

The configured tool (default `subagent_oar` from [`dsh-tool-subagent-oar`](../tool-subagent-oar/README.md)) forwards `runtime`, `description`, and the complete `prompt`; the child sees nothing else from this conversation.

#### Token effect

The delegated task runs entirely inside the native runtime; the parent request carries only the tool declaration and the tool result, so the parent token cost is independent of child size.

#### KV Cache effect

Delegation does not mutate the parent prefix: the tool call and its result append at the conversation tail, leaving every earlier parent KV entry valid.

## Known Limitations and Deferred Work

- The OAR runtime's own floor is Node >= 24.0.0; the provider refuses on older Hosts rather than raising the repository-wide engine floor (recorded divergence against upstream's root-floor raise).
- The provider names only runtimes in OAR's default registry; custom OAR runtimes would require exposing a registry seam (deferred until a concrete need exists).
