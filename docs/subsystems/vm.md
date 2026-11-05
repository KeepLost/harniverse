# VM execution worlds

English | [中文](vm.zh.md)

The execution-world seam is split across a Service Definition ([dsh-vm](../../packages/vm/vm), `ctx.vm`), the local Service Provider ([dsh-vm-qemu-local](../../packages/vm/vm-qemu-local) boots a QEMU micro-VM with no network device), and the capability providers that run the harness contracts inside one world: [dsh-subprocess-vm](../../packages/vm/subprocess-vm) serves `ctx.subprocess`, [dsh-fs-vm](../../packages/vm/fs-vm) serves `ctx.fs`, and [dsh-sandbox-vm](../../packages/vm/sandbox-vm) serves `ctx.sandbox` with the world boundary as the enforcement. The seam owns the world-neutral exec vocabulary below, the eight world-filesystem operations, the `EgressPolicy` approval callback every provider consults before a host-side dial, and the shared error taxonomy (`ExecStartError`, `ExecOptionsError`, `ExecOutputLimitError`, `GuestFsError`); no hypervisor, transport, or protocol concept appears in the contract.

Source: [`packages/vm/vm/src/types.ts`](../../packages/vm/vm/src/types.ts) and [`packages/vm/vm/src/index.ts`](../../packages/vm/vm/src/index.ts)

## Exec vocabulary

One exec is one id: `exec` collects to completion with a bound; `spawn` streams. Environment replaces the world's ambient default entirely; paths are world-absolute.

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
