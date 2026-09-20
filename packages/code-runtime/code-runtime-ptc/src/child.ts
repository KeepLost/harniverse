/**
 * Spawn-only child entrypoint over {@link runChildMain}. Executable logic stays in
 * `child-exec.ts` for in-process coverage; real-child tests cover this glue. The
 * control channel rides the process stdio pair: frames on stdin/stdout, with the
 * program-visible `process.stdout`/`process.stderr` write slots patched into the
 * log capture so JS-level writes never corrupt the frame stream.
 * @module @deepseek-ai/dsh-code-runtime-ptc/src/child
 */

import { Writable } from 'node:stream'
import { ControlChannelTransport } from '@deepseek-ai/dsh-control-channel'
import { ensureBoundaryIntrinsics, runChildMain } from './child-exec.ts'
import type { ChildBootData } from './child-exec.ts'

/**
 * The boot target the host's opening control call names. One target per
 * child process: the channel exists for exactly one program.
 */
const RUN_TARGET = 'run'

/** The channel end this child drives, once the stdio pair is wired. */
let channel: ControlChannelTransport | undefined

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
          void runChildMain(channel as ControlChannelTransport, data, { stdout: process.stdout, stderr: process.stderr })
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
