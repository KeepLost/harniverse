/**
 * stdio transport for one external ACP agent over the subprocess seam: spawn,
 * protocol streams, startup failure observation, and the cooperative teardown
 * ladder. The agent's diagnostics stay on the parent's stderr.
 * @module @deepseek-ai/dsh-acp-client/transport
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpError } from './errors.ts'
import type { AcpAgentDefinition } from './types.ts'

/** EOF grace for the agent's final flush and its own nested-process teardown; wider than the signal grace. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** The byte streams one ACP connection speaks over, and the end of its output. */
export interface AcpIo {
  /** Bytes this client writes to the agent. */
  readonly output: WritableStream<Uint8Array>
  /** Bytes this client reads from the agent. */
  readonly input: ReadableStream<Uint8Array>
  /**
   * Settles once the output stream closed or failed. A write that was in
   * flight when that happened may still settle, so the peer ends pending
   * requests on this signal rather than on the write.
   */
  readonly outputClosed: Promise<void>
}

/** A spawned agent process with the ways to observe and end it. */
export interface AcpChild {
  readonly io: AcpIo
  /**
   * Rejects with an `AcpError` of kind `spawn` when the process could not
   * start. It never settles when the process exits cleanly.
   */
  readonly failed: Promise<never>
  /** The process tree's outcome once it exited; a failed start reports no exit. */
  readonly exited: Promise<SubprocessOutcome>
  /** Run the teardown ladder. Later calls join the first. */
  dispose(): Promise<void>
}

/** What {@link spawnAcpChild} needs. */
export interface SpawnAcpChildOptions {
  readonly definition: AcpAgentDefinition
  /** Absolute working directory of the process. */
  readonly cwd: string
  /** Spawn function of the subprocess seam. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly disposeEofGraceMs: number
  readonly disposeGraceMs: number
}

/** Bounded whole-tree exit wait: polls the handle's tree liveness until it exits or `ms` elapses. */
async function treeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown ladder for an out-of-process agent over the seam's
 * public verbs. It resolves only at whole-tree quiescence: stdin EOF (the
 * agent's window to flush persistence and reap its own descendants), then the
 * `terminate()` escalation (SIGTERM, the spawn grace, SIGKILL; Windows
 * force-terminates directly) and its whole-tree exit proof.
 * @param child - the spawned agent's handle.
 * @param eofGraceMs - window after stdin EOF before the escalation.
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  // A failed start has no process to tear down; observe the rejection so a
  // disposal in a finally block cannot surface it as unhandled.
  if (child.pid <= 0) {
    await child.done.catch(() => {
      // The spawn failure is reported by whoever raced it.
    })
    return
  }
  child.stdin?.end()
  if (await treeExitsWithin(child, eofGraceMs)) return
  // terminate() owns the bounded SIGTERM → SIGKILL timer. Its unbounded wait
  // is the process owner's exit proof, not a second derived grace.
  child.terminate()
  await child.waitForExit()
}

/**
 * Start one agent process and expose its protocol streams.
 * @param options - the agent definition, the seam's spawn function, the
 *   working directory, and the two teardown graces.
 * @returns the spawned child.
 */
export function spawnAcpChild(options: SpawnAcpChildOptions): AcpChild {
  const { definition } = options
  // The seam's scrub drops ambient credentials and DSH_* names; the
  // definition's explicit env merges after it.
  const child = options.spawn({
    argv: [definition.command, ...(definition.args ?? [])],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: options.disposeGraceMs,
    env: definition.env === undefined ? {} : { ...definition.env },
  })
  /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('acp-client: the subprocess implementation dropped a piped protocol stream')
  }
  /* v8 ignore stop */
  // The output's end is reported from the stream itself: a write queued when
  // the stream dies can settle normally on some Node releases.
  const outputClosed = Promise.withResolvers<void>()
  const closeOutput = (): void => { outputClosed.resolve() }
  child.stdin.once('close', closeOutput)
  child.stdin.once('error', closeOutput)
  // A failed start surfaces as `done` rejecting; a clean exit must never
  // settle `failed`, so the success arm parks forever.
  const failed: Promise<never> = child.done.then(
    /* v8 ignore next -- the success arm's never-settling executor is intentionally empty. */
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(new AcpError('spawn', `the agent process failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })),
  )
  void failed.catch(() => {
    // The failure is observed by whoever races it; this keeps it never unhandled.
  })
  let disposal: Promise<void> | undefined
  return {
    io: {
      output: NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      input: NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      outputClosed: outputClosed.promise,
    },
    failed,
    exited: child.done.catch(() => ({ exitCode: null, signal: null })),
    dispose: () => (disposal ??= disposeAcpChild(child, options.disposeEofGraceMs)),
  }
}
