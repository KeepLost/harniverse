/** Private installed entry; OpenSSH carries stdin/stdout and owns the process lifetime. */
import { fileURLToPath } from 'node:url'
import { runSshHelper } from './helper.ts'

const controller = new AbortController()
const stop = (): void => { controller.abort(new Error('SSH helper terminated')) }
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop)
try {
  await runSshHelper({ input: process.stdin, output: process.stdout, entryPath: fileURLToPath(import.meta.url), signal: controller.signal })
} catch (error) {
  process.stderr.write(`SSH helper: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, stop)
}
