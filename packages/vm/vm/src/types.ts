/**
 * World-neutral vocabulary for the `ctx.vm` execution-world seam: the exec
 * surface (collecting and streaming), the guest-filesystem operation set, the
 * egress-approval callback shapes, and the world descriptor facts. Types only
 * — no runtime code. A provider package (`@deepseek-ai/dsh-vm-qemu-local`)
 * owns every transport, hypervisor, and protocol detail behind this
 * vocabulary; nothing here names one.
 * @module @deepseek-ai/dsh-vm/types
 */

/** Options shared by the collecting `exec` and the streaming `spawn`. */
export interface ExecOptions {
  /** Environment for the child; replaces the world's default entirely. */
  env?: Record<string, string>
  /** Absolute working directory inside the world; default `/`. */
  cwd?: string
  /** Allocate a pty (stderr then merges into stdout on the wire). */
  pty?: boolean | { rows: number; cols: number }
}

/** Options of a collecting exec. */
export interface CollectExecOptions extends ExecOptions {
  /** Full stdin payload, written once and closed before awaiting the exit. */
  stdin?: Uint8Array | string
  /** Kill the exec with SIGKILL after this many milliseconds; the result is
   * still returned, flagged `timedOut`. */
  timeoutMs?: number
  /** Bound on the combined collected stdout and stderr; exceeding it kills
   * the exec and rejects with `ExecOutputLimitError`. */
  maxOutputBytes?: number
}

/** How one exec ended. */
export interface ExecExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Result of a collecting exec. */
export interface ExecResult extends ExecExit {
  stdout: Buffer
  stderr: Buffer
  /** True when the timeout fired and the exec was killed for it. */
  timedOut: boolean
}

/** Output listener signature of a streaming exec. */
export type ExecOutputListener = (stream: 'stdout' | 'stderr', chunk: Buffer) => void

/** Handle for one streaming exec inside the world. */
export interface ExecHandle {
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

/** One file stat as reported by the world's filesystem. */
export interface GuestStat {
  /** `file` or `dir`. */
  kind: 'file' | 'dir'
  /** Size in bytes; 0 for directories. */
  size: number
  /** Permission bits as the world reports them (numeric mode). */
  mode: number
  /** Modification time in milliseconds since the world's epoch. */
  mtimeMs: number
}

/** One directory entry as reported by `VmWorldFs.list`. */
export interface GuestEntry {
  /** Entry name without the directory part. */
  name: string
  /** `file` or `dir`. */
  kind: 'file' | 'dir'
}

/**
 * Filesystem operations of one execution world. All paths are absolute paths
 * inside the world; callers never apply host paths here.
 */
export interface VmWorldFs {
  /**
   * Read one file.
   * @param path - absolute world path.
   * @returns the file bytes; files above the provider's wire cap reject with EFBIG.
   */
  readFile(path: string): Promise<Buffer>
  /**
   * Write one file, truncating or creating it.
   * @param path - absolute world path.
   * @param data - bytes or UTF-8 text; at most the provider's payload cap.
   */
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  /**
   * Stat one path.
   * @param path - absolute world path.
   * @returns kind, size, permission bits, and mtime.
   */
  stat(path: string): Promise<GuestStat>
  /**
   * List one directory.
   * @param path - absolute world directory.
   * @returns its entries with file/dir kinds.
   */
  list(path: string): Promise<GuestEntry[]>
  /**
   * Create one directory.
   * @param path - absolute world path.
   * @param options - `recursive` creates parents like `mkdir -p`.
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  /**
   * Remove one file.
   * @param path - absolute world path.
   */
  unlink(path: string): Promise<void>
  /**
   * Remove one empty directory.
   * @param path - absolute world path.
   */
  rmdir(path: string): Promise<void>
  /**
   * Rename or move one path.
   * @param from - absolute source path.
   * @param to - absolute destination path.
   */
  rename(from: string, to: string): Promise<void>
}

/** One guest egress request the host relay is asked to dial. */
export interface EgressRequest {
  /** Remote host the world's process asked to reach. */
  host: string
  /** Remote port. */
  port: number
}

/**
 * Approval callback for one world's egress relay; when omitted every dial
 * denies. The callback is the SPI-level governance seam: providers consult it
 * before any host-side dial, so governance follows the world regardless of
 * which provider opened it.
 * @param request - the dial the world's guest asked for.
 * @returns true to approve the relay, false to deny.
 */
export type EgressPolicy = (request: EgressRequest) => boolean | Promise<boolean>

/**
 * Facts about one booted world, in provider-neutral terms.
 */
export interface VmWorldDescriptor {
  /** Provider id, e.g. `qemu-local`; stable within one deployment. */
  readonly provider: string
  /**
   * Host-isolation completeness this world proves: `'full'` means the world's
   * processes cannot reach host files, processes, or network by construction
   * (a hardware-virtualized world), not by policy promise.
   */
  readonly isolation: 'full'
  /**
   * The in-world process-confinement backend this world's guest proves at
   * boot: `'landlock'` means the guest announced a kernel-enforcing backend
   * the sandbox capability can wrap argv with (file effects inside the
   * world), `'none'` means confined modes must fail closed.
   */
  readonly guestConfinement: 'landlock' | 'none'
  /**
   * True when the provider's own host child runs under its host-side
   * hardening (privilege drop, filesystem confinement), so a provider
   * compromise does not imply host compromise.
   */
  readonly hostHardened: boolean
  /** Milliseconds from provider start to the accepted world handshake. */
  readonly readyMs: number
}

/** How the provider child terminated. */
export interface VmWorldExit {
  code: number | null
  signal: NodeJS.Signals | null
}
