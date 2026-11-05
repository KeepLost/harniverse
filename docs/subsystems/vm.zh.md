# VM 执行世界

[English](vm.md) | 中文

执行世界缝隙分为 Service Definition（[dsh-vm](../../packages/vm/vm)，`ctx.vm`）、本地 Service Provider（[dsh-vm-qemu-local](../../packages/vm/vm-qemu-local) 启动没有网络设备的 QEMU micro-VM）与在一个世界内运行 harness 契约的能力 provider：[dsh-subprocess-vm](../../packages/vm/subprocess-vm) 服务 `ctx.subprocess`，[dsh-fs-vm](../../packages/vm/fs-vm) 服务 `ctx.fs`，[dsh-sandbox-vm](../../packages/vm/sandbox-vm) 以世界边界为强制服务 `ctx.sandbox`。缝隙拥有下列世界中立的 exec 词表、八项世界文件系统操作、所有 provider 在宿主侧拨号前请示的 `EgressPolicy` 审批回调，以及共享错误分类（`ExecStartError`、`ExecOptionsError`、`ExecOutputLimitError`、`GuestFsError`）；契约里没有任何 hypervisor、传输或协议概念。

Source: [`packages/vm/vm/src/types.ts`](../../packages/vm/vm/src/types.ts) and [`packages/vm/vm/src/index.ts`](../../packages/vm/vm/src/index.ts)

## Exec 词表

一个 exec 一个 id：`exec` 有界收集到完成；`spawn` 流式。环境整体替换世界默认；路径为世界绝对路径。

```ts type-equiv
/** Options shared by the collecting `exec` and the streaming `spawn`. */
interface ExecOptions {
  /** Environment for the child; replaces the world's default entirely. */
  env?: Record<string, string>
  /** Absolute working directory inside the world; default `/`. */
  cwd?: string
  /** Allocate a pty (stderr then merges into stdout on the wire). */
  pty?: boolean | { rows: number; cols: number }
}
```

```ts type-equiv
/** Options of a collecting exec. */
interface CollectExecOptions extends ExecOptions {
  /** Full stdin payload, written once and closed before awaiting the exit. */
  stdin?: Uint8Array | string
  /** Kill the exec with SIGKILL after this many milliseconds; the result is
   * still returned, flagged `timedOut`. */
  timeoutMs?: number
  /** Bound on the combined collected stdout and stderr; exceeding it kills
   * the exec and rejects with `ExecOutputLimitError`. */
  maxOutputBytes?: number
}
```

```ts type-equiv
/** Result of a collecting exec. */
interface ExecResult extends ExecExit {
  stdout: Buffer
  stderr: Buffer
  /** True when the timeout fired and the exec was killed for it. */
  timedOut: boolean
}
```

```ts type-equiv
/** Handle for one streaming exec inside the world. */
interface ExecHandle {
  /** Id this exec was claimed under inside the world. */
  readonly id: number
  /** World-side process id. */
  readonly pid: number
  /**
   * Write one stdin chunk; providers split chunks above their wire cap.
   * @param chunk - bytes or UTF-8 text to append to the child's stdin.
   */
  writeStdin(chunk: Uint8Array | string): void
  /** Close the child's stdin; it then reads EOF. */
  closeStdin(): void
  /**
   * Deliver a signal to the child.
   * @param sig - signal name; the world maps the common POSIX set.
   */
  signal(sig: NodeJS.Signals): Promise<void>
  /** Resolves once with the exit state, or rejects when the world closes. */
  readonly exit: Promise<ExecExit>
  /**
   * Subscribe to output chunks.
   * @param listener - called per stdout/stderr chunk.
   * @returns the unsubscribe function.
   */
  onOutput(listener: ExecOutputListener): () => void
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvm--vmworld-abstract-seam"></a>

### `ctx.vm` — `VmWorld` (abstract seam)

One booted execution world. Implementations boot in the constructor, settle in `[Service.init]`, and destroy their world on context disposal — a consumer never sees a half-booted world, and no world outlives its context.

Implementations must honor these semantics:

- Every path argument is a path INSIDE the world; a host path is never valid here, and implementations never read one.
- The guest cannot reach host files, processes, or the network by construction; egress exists only through the provider's approval-gated relay (`EgressPolicy`), which denies when unapproved.
- `destroy` is idempotent and resolves once the world's processes cannot run anymore, however it was stopped.

```ts cordis-catalog
/**
 * Round-trip one ping through the world's agent.
 * @param timeoutMs - reply deadline; provider default applies when omitted.
 * @returns observed round-trip time in milliseconds.
 */
abstract ping(timeoutMs?: number): Promise<number>

/**
 * Run one exec to completion inside the world and collect its output.
 * @param argv - world command line.
 * @param options - env, cwd, pty, stdin, timeout, and output bound.
 * @returns exit state plus collected stdout and stderr.
 */
abstract exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult>

/**
 * Start one streaming exec inside the world.
 * @param argv - world command line.
 * @param options - env, cwd, and pty selection.
 * @returns the streaming exec handle.
 */
abstract spawn(argv: string[], options?: ExecOptions): Promise<ExecHandle>

/**
 * Stop the world.
 * @returns `clean` when the world exited after its own shutdown path (or
 * had already exited), `killed` when forceful termination was required.
 */
abstract destroy(): Promise<'clean' | 'killed'>
```

Source: [`packages/vm/vm/src/index.ts:63`](../../packages/vm/vm/src/index.ts)
<!-- END GENERATED cordis-surface -->
