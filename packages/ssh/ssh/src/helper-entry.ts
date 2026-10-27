/** Private installed entry; OpenSSH carries stdin/stdout and owns the process lifetime. */
/* v8 ignore file -- launched through plain Node over OpenSSH; the helper module's behavior is covered through its explicit streams. */
import { fileURLToPath } from 'node:url'
import { runSshHelper } from './helper.ts'

const controller = new AbortController()
const stop = (): void => { controller.abort(new Error('SSH helper terminated')) }

/** Run the helper to completion; stdin keeps the process alive until the streams close. */
function main(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop)
  void runSshHelper({
    input: process.stdin,
    output: process.stdout,
    entryPath: fileURLToPath(import.meta.url),
    signal: controller.signal,
  }).catch((error: unknown) => {
    process.stderr.write(`SSH helper: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }).finally(() => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, stop)
  })
}

main()
