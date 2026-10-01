#!/usr/bin/env node
/** Native Node entry for the installed remote-server composition. */
import 'node-addon-require-builtin'
import { parseArgs } from 'node:util'
import { runRemoteServer } from './index.ts'

const { values } = parseArgs({ options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
if (values.help) {
  process.stdout.write('dsh-remote-server [--port 0]\nUses DSH_HOME; authenticated loopback listener; endpoint: server/endpoint.json\n')
  process.exit(0)
} else {
  if (values.port !== undefined && values.port !== '0') throw new Error('remote-server: --port must be 0')
  let stopping: Promise<void> | undefined
  const started = runRemoteServer()
  const stop = (code: number): void => {
    if (stopping !== undefined) return
    process.exitCode = code
    const deadline = setTimeout(() => { process.exit(code || 1) }, 10_000)
    stopping = started.then(ctx => ctx.fiber.dispose(), () => {}).finally(() => {
      clearTimeout(deadline)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      process.off('uncaughtException', fatal)
      process.off('unhandledRejection', fatal)
    })
  }
  const interrupt = () => { stop(130) }
  const terminate = () => { stop(143) }
  const fatal = (error: unknown) => {
    process.stderr.write(`remote-server: ${error instanceof Error ? error.message : String(error)}\n`)
    stop(1)
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  await started.catch(fatal)
}
