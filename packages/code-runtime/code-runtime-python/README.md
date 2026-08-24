# @deepseek-ai/dsh-code-runtime-python

English | [中文](README.zh.md)

Fresh-CPython-process Service Provider for the [`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam. It registers `ctx.codeRuntime` with `language: 'python'` and `isolation: 'process'`; each `run()` starts one Python process, executes one async-function body, waits for process exit, and retains no state for the next run.

This provider is opt-in. No shipped Profile selects it. A deployment that already enables Code Mode replaces its `code-runtime` Cordis config entry with:

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-python'
```

`dsh-tools` reads `ctx.codeRuntime.language`, so the existing `run_code` Consumer projects its Python SDK and Python schema strings without a Python-specific tool or agent-loop branch.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `pythonExecutable` | `python3` | Non-empty executable name or path passed directly to `spawn()`; no shell interprets it. The executable must provide CPython 3.10 or newer. |
| `cpuSeconds` | `60` | Positive whole-second `RLIMIT_CPU` soft limit, applied where Python exposes `resource.RLIMIT_CPU`. |
| `maxWallMs` | `600000` | Positive Host wall-clock ceiling, including bootstrap and binding waits. |
| `maxAddressSpaceMb` | `512` | Positive whole-MiB `RLIMIT_AS` soft limit, applied where supported. |
| `maxOutputBytes` | `67108864` | Combined serialized budget for ordered logs plus the completion value or failure message. |
| `maxControlBytes` | `67109888` | Maximum JSONL frame width on fd 3; must leave 1 KiB above `maxOutputBytes`. This provider limit also bounds one binding argument or resolution frame. |

Invalid config fails plugin setup. A missing executable, interpreter exit, resource death, malformed oversized frame, program exception, timeout, abort, invalid completion, or output overflow resolves through `CodeRunResult.error`; invalid portable bindings, disposal misuse, and invalid config reject as Service Definition misuse.

## Process and protocol

Node spawns `pythonExecutable` with `['-I', '-B', py/bootstrap.py]`, `shell: false`, and an empty environment. fd 3 carries one versionless JSON object per line: Host sends `boot`, waits for `boot-ack`, sends `run`, services `call` frames with `reply`, and accepts one `done`. `src/protocol.ts` and `py/protocol.py` mirror every required and optional field; the real-`python3` mirror test checks both rosters.

The Host treats every child frame as hostile: it caps lines before parsing, rejects integer tokens that JavaScript would round, validates and rebuilds known frames field by field, ignores unknown/malformed frames and duplicate call ids, uses own-property binding lookup, and revalidates completion values. Child errors and Host process failures expose bounded diagnostics without process paths, environment values, stacks, or raw protocol payloads.

The bootstrap uses only the Python standard library. It wraps model source in `async def __dsh_main__()` so top-level `await` and `return` work, injects each namespace as async functions, materializes optional typed binding exceptions, and validates arguments, replies, and completion values as lossless JSON. Python-level stdout/stderr writes and `console.log`/`warn`/`error` calls use one ordered protocol stream; native writes that bypass `sys.stdout`/`sys.stderr` remain bounded Host-captured backstops.

Disposal marks the provider unusable, fails every live run as aborted, kills each child, and awaits all child exits before the Cordis fiber settles.

## Model Experience

### Python Code Mode selection

#### What the model sees

Code Mode in [`dsh-tools`](../../core/tools/README.md) selects its existing Python SDK and `run_code` wording from this provider's `language` descriptor, then renders bounded logs, a lossless JSON completion, or a sanitized failure into the retained tool result.

#### Token effect

Selecting this provider replaces the TypeScript Code Mode SDK and tool-description tokens with their Python forms; run results retain only the bounded logs, completion, or failure selected by the Consumer.

#### KV Cache effect

Selecting this provider changes the Code Mode SDK and `run_code` schema from TypeScript to Python for new assembled requests; unchanged Python assemblies keep a stable prefix.

## Known Limitations and Deferred Work

- **Process isolation is not a sandbox** — model code shares the Host filesystem, working directory, network, and operating-system identity. The empty environment limits accidental credential inheritance but does not create a security boundary; use a container backend for hostile-code confinement.
- **Resource limits are platform-dependent** — `RLIMIT_CPU` and `RLIMIT_AS` apply only where Python's `resource` module and named limits exist; `maxWallMs`, process termination, control framing, and output caps remain Host-enforced everywhere.
- **Python cannot distinguish an explicit `return None` from falling off an async function** — both complete as JSON `null`; callers that need an absent completion cannot express that distinction through Python function return semantics.
- **Native fd 1/fd 2 writes bypass the ordered Python stream** — the Host still captures and bounds them, but operating-system delivery between the two independent pipes cannot promise their original cross-fd order.
- **The Python SDK renderer follows Node's Unicode identifier tables** — CPython 3.10 may reject a non-ASCII tool-derived identifier added by a newer Unicode version; ASCII tool names are unaffected, and exotic names remain reachable through indexed namespace access.
