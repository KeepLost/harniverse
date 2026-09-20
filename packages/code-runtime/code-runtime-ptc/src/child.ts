/**
 * Spawn-only child entrypoint over {@link runChildMain}. Executable logic stays in
 * `child-exec.ts` for in-process coverage; real-child tests cover this glue. The
 * control channel rides the process stdio pair: frames on stdin/stdout, with the
 * program-visible `process.stdout`/`process.stderr` write slots patched into the
 * log capture so JS-level writes never corrupt the frame stream.
 * @module @deepseek-ai/dsh-code-runtime-ptc/src/child
 */

import { Writable } from 'node:stream'
import { runChildMain, ensureBoundaryIntrinsics } from './child-exec.ts'
import type { ChildBootData } from './child-exec.ts'

/** What the child needs from the control-channel package to drive its transport. */
type ControlChannelModule = typeof import('@deepseek-ai/dsh-control-channel')

/**
 * Load the transport class for this child's world. Built worlds resolve the
 * workspace package by name (its exports point at `lib/`). Buildless source
 * worlds — unit lanes that never run the workspace build — have no `lib/`, so
 * the bare import fails and the dependency's own source entry serves instead
 * (linked `node_modules`, whether beside this entry or one directory up);
 * it is erasable-only TypeScript exactly like this entry file itself.
 */
const CONTROL_CHANNEL_SOURCE_FALLBACKS = [
  '../node_modules/@deepseek-ai/dsh-control-channel/src/index.ts',
  './node_modules/@deepseek-ai/dsh-control-channel/src/index.ts',
] as const

async function loadControlChannel(): Promise<ControlChannelModule> {
  try {
    return await import('@deepseek-ai/dsh-control-channel')
  } catch {
    let failure: unknown
    for (const candidate of CONTROL_CHANNEL_SOURCE_FALLBACKS) {
      try {
        return await import(new URL(candidate, import.meta.url).href) as ControlChannelModule
      } catch (error: unknown) { failure = error }
    }
    throw failure
  }
}

/**
 * The boot target the host's opening control call names. One target per
 * child process: the channel exists for exactly one program.
 */
const RUN_TARGET = 'run'

/** The constructor type from the control-channel package this child drives. */
type Transport = InstanceType<ControlChannelModule['ControlChannelTransport']>

/** The channel end this child drives, once the stdio pair is wired. */
let channel: Transport | undefined

/**
 * Parse and validate the boot call's argument list. The host built it, so a
 * malformed payload is a host-side contract violation reported as a failed
 * reply rather than a crash.
 */
function parseBootArgs(args: readonly unknown[]): ChildBootData {
  const [code, namespaces, maxOutputBytes, computeMs, maxLogFrameBytes] = args as [unknown, unknown, unknown, unknown, unknown]
  if (typeof code !== 'string' || !Array.isArray(namespaces)
    || typeof maxOutputBytes !== 'number' || typeof computeMs !== 'number' || typeof maxLogFrameBytes !== 'number') {
    throw new Error('boot payload must be [program, namespaces, maxOutputBytes, computeMs, maxLogFrameBytes]')
  }
  return { code, namespaces: namespaces as ChildBootData['namespaces'], maxOutputBytes, computeMs, maxLogFrameBytes }
}

/**
 * Wire the child's channel and serve the boot call. The transport writes
 * through a wrapper bound to the ORIGINAL `process.stdout.write` — the
 * program-facing stream object is patched separately by {@link runChildMain}
 * — then the program runs to settlement and the child settles with it.
 */
async function main(): Promise<void> {
  const { ControlChannelTransport } = await loadControlChannel()
  const intrinsicWrite: (chunk: Buffer | string, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => boolean
    = process.stdout.write.bind(process.stdout)
  // The wrapper gives the transport a private writable end: patching the
  // program-visible `process.stdout.write` later must not redirect channel
  // frames into the log capture.
  const channelOutput = new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      intrinsicWrite(chunk, encoding, callback)
    },
  })
  channel = new ControlChannelTransport({
    input: process.stdin,
    output: channelOutput,
    handlers: {
      onCall: (frame) => {
        if (frame.target !== RUN_TARGET) throw new Error(`child refuses unknown target ${JSON.stringify(frame.target)}`)
        let data: ChildBootData
        try {
          data = parseBootArgs(frame.args)
        } catch (error: unknown) {
          // A malformed boot payload is a host-side contract violation: let
          // the failure reply cross, then exit rather than wait on a channel
          // whose peer will never send a terminal frame.
          setTimeout(() => { process.exit(1) }, 50)
          throw error
        }
        // The boot reply is the acceptance ack; queue the program as a
        // macrotask so the reply ALWAYS precedes the run's first frame,
        // keeping the host's boot-await deterministic.
        setTimeout(() => {
          void runChildMain(channel as Transport, data, { stdout: process.stdout, stderr: process.stderr })
            .catch(() => { process.exitCode = 1 })
          // The program's synchronous prefix has already run by the first
          // suspension inside runChildMain: restore any boundary intrinsics
          // it dirtied BEFORE this timer's callback returns and Node's
          // async_hooks bookkeeping pops through the mutated prototypes.
          ensureBoundaryIntrinsics()
        }, 0)
        return Promise.resolve(true)
      },
    },
  })
  await channel.waitSettled()
  await channel.dispose()
}

void main().catch(() => {
  process.exitCode = 1
  channel?.cancel('child failed to start')
})
