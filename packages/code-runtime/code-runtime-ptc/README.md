# @deepseek-ai/dsh-code-runtime-ptc

English | [中文](README.zh.md)

Fresh-process PTC implementation of the [`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam: `PtcCodeRuntime` runs each program in ONE fresh Node child process over the shared control channel ([`dsh-control-channel`](../../subprocess/control-channel/README.md)) — TypeScript in, type-stripped host-side, bindings bridged as control calls, `{ value, logs, error? }` out. **Containment, not a security boundary**: trust posture is bash-equivalent by design (the [Code Mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) § Trust posture), with containment bash does not have — separate process, empty environment, sandbox parity with the deployment's Bash policy, heap cap, deadline with forced kill.

## Config

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-ptc'
  config:
    computeMs: 60000              # busy-time budget (child-metered event-loop active time)
    maxWallMs: 600000             # wall-clock deadline; never pauses for anything
    maxOutputBytes: 67108864      # combined serialized outer-output cap (64 MiB)
    maxOldGenerationSizeMb: 512   # child heap cap (--max-old-space-size)
```

Every field is validated and defaulted; `maxOutputBytes` is a safe integer of at least four bytes, the remaining fields are positive finite numbers, `maxWallMs` is additionally at most `2147483647` (Node's maximum `setTimeout` delay), and there are no other tunables.

## Design

- **One fresh process per run, no pooling** — a program's world dies with its child: no cross-run state to log, state bleed unrepresentable, runs reconstructable from the session log alone.
- **Type-strip host-side, in execution context** — the program is wrapped in an async-function shell, stripped with `node:module`'s `stripTypeScriptTypes` (erasable syntax only — `enum`/namespaces are rejected as a program `exception` and no child spawns), and sliced back out byte-positioned; it then executes as the body of an `AsyncFunction`, so top-level `await`/`return` work.
- **The channel assumes a hostile peer** — model code shares the child's process, so every inbound frame is length-prefixed JSON that the [`dsh-control-channel`](../../subprocess/control-channel/README.md) transport bounds, decodes, and dispatches defensively: unknown call targets are answered with a failure, binding names resolve as OWN properties only (a forged `constructor` cannot walk a prototype chain), post-settlement replies drop, and every binding resolution and completion is validated as lossless JSON before it counts. The host accounts every admitted log plus the completion or diagnostic against the outer cap regardless of what the child claims.
- **Binding rejection classes are request data** — an optional namespace descriptor names the constructor global and the own property that receives the failed member name. The child materializes and injects that real class, so `instanceof` works without hardcoding `tools` or `ToolCallError`; declarations with invalid or colliding globals fail before a child spawns. Failures use module-captured error and property-definition intrinsics plus null-prototype descriptors, so later model mutations cannot turn a rejected binding into a child crash.
- **Two independent budgets, because the peer is hostile** — `computeMs` meters the child's MEASURED busy time (in-process `performance.eventLoopUtilization()` sampling): a program awaiting a slow tool accrues nothing, and a decoy pending dispatch cannot pause it. A hot synchronous loop starves the child's own sampler, so `maxWallMs` backstops it as the host-owned control-channel deadline, enforced by a close-grace escalation to `SIGKILL`. Heap overflow kills the child, surfacing as the process exit (`kind: 'worker-exit'`). `maxWallMs` is range-checked at load against `MAX_TIMER_DELAY_MS`: `setTimeout` clamps a longer delay to 1 ms, so a positivity check alone would accept a ceiling that expires on the first tick.
- **Intermediate binding values are complete JSON** — binding arguments and resolutions undergo iterative lossless-JSON validation. Before program execution, the child captures its own realm's plain-container prototype identities plus the native function-source check used only for foreign realms, so constructor-slot mutation and user-authored impostors cannot change container classification. It also captures every structural and metering intrinsic used by this JSON boundary, creates property descriptors without a prototype, and bypasses mutable collection prototypes for private traversal state; model mutations of globals, prototype methods, or descriptor-shaped `Object.prototype` fields therefore cannot alter validation, wire transport, or byte accounting. Values flatten into a bounded-depth pre-order wire value for the JSON frame and rebuild iteratively on the other side. They have no byte, JavaScript call-stack, or nested depth cap of their own. They never enter the outer-output ledger or model context; provider/executor acquisition bounds and process memory remain the limits.
- **Logs stream eagerly into one outer ledger** — console/stdout/stderr text crosses the channel as `log` frames in emission order, each truncated to stay encodable within the channel's frame bound, so a timed-out or killed program still shows what it printed. The child charges exact JSON-string bytes and preflights completion values and exception diagnostics against the remaining combined budget before sending them; a thrown million-byte stack therefore becomes the fixed `output-limit` diagnostic at the child boundary. Native stderr writes that bypass the patched stream slots arrive on the host's stray pipe and repeat the ledger; a native write to the frame fd corrupts the channel and fails the run contained as `worker-exit`. `maxOutputBytes` accounts the JSON serialization of the outer `logs` array plus the completion value or failure-message payload; fixed `CodeRunResult` field names, braces, the bounded error-kind tag, and later presentation whitespace are outside that variable-payload ledger. At or below the cap the exact value returns; a lossy completion is `invalid-output`, and a combined overflow is `output-limit` rather than a substituted inspected string.
- **Empty environment, sandbox parity** — the child gets `env: {}` and an argv built from scratch (heap flag plus entry): no ambient credentials (stronger than the scrubbed-env rule for spawned commands) and no inherited loader flags. The spawn resolves the deployment's [`dsh-sandbox-policy`](../../sandbox/sandbox-policy/README.md) default and wraps the argv through `ctx.sandbox` exactly like the Bash family: confined modes fail closed without a provider (`SandboxUnavailableError` from `run()`), `danger-full-access` spawns raw, and the resolved workspace root is the child's cwd.
- **Dispose to quiescence** — teardown fails in-flight runs as `abort` and AWAITS each child's exit before resolving.

## The child entry, unbuilt and built

Source mode loads erasable-only `src/child.ts` through Node's native type stripping; its transitive closure is Node built-ins, relative source modules, and the shared `dsh-control-channel` contract (resolved through the workspace's built exports), so a fresh checkout never requires this package's own unbuilt `lib/`. The child-local and session-owned JSON boundaries both flatten and rebuild validated values around the JSON frame so application nesting never reaches a clone boundary. Built mode passes the sibling `lib/child.cjs` as a filesystem path because pkg's VFS child-process hook expects CommonJS; the same path works under ordinary Node. The repository-wide requirement to exercise this published entry path belongs to the [testing policy](../../../docs/testing.md).

The SDK API is the default/named `PtcCodeRuntime` class plus `Config`. The operational `./child` subpath exists only as the packaged spawn entry; the frame mapping and executor helpers are source-private implementation details.

## Model Experience

Indirectly, through Code Mode in [`dsh-tools`](../../core/tools/README.md), which renders the exact outer value when it fits or an explicit `invalid-output` / `output-limit` failure. Only the outer `run_code` result enters model context and its ordinary spill policy; binding traffic and intermediate values remain execution-local.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **OS processes a program spawns survive termination** — the grace kill targets the child only, weaker than bash-local's process-group kill; orphan cleanup is a deployment concern until a container backend exists.
- **A hot synchronous loop is ended by `maxWallMs`, not `computeMs`** — the busy-time sampler starves inside such a loop (a process offers no cross-process ELU probe), so the wall deadline is the budget that fires; its message names the deadline rather than the compute budget.
- **Raw writes to the frame fd corrupt the channel** — JS-level `process.stdout.write` is captured, but a native-style write to fd 1 interleaves with frame bytes and fails the run as `worker-exit`; likewise reading `process.stdin` steals frame bytes. The documented API surface (console shim, patched streams, bindings) stays clean.
- **One program must fit the channel frame bound** — the boot frame carries the whole type-stripped program; beyond `maxFrameBytes` (1 MiB by default) the run fails as `worker-exit` naming the bound.
- **Type-strip rides Node's experimental `stripTypeScriptTypes` API** — amaro or sucrase are the named drop-in replacements if the relied-on behavior shifts.
- **`computeMs` expiry can overshoot by up to one poll interval** — busy time is sampled every 25 ms (an internal constant, deliberately not config).
- **Programs get a five-method `console` shim** (`log`/`info`/`warn`/`error`/`debug`) — deliberately not Node's full console API.
- **Intermediate binding values have no byte cap** — a program can exhaust process memory with a value that never becomes outer output.
- **The 64 MiB default is a rejection boundary, not recoverable storage** — outer spill can save only the bounded logs and diagnostic returned after `output-limit`; bytes rejected beyond the runtime cap never reach the spill layer.
