/** Run one benchmark under a Linux process-tree RSS safety ceiling. */

import { spawn } from 'node:child_process'
import { processTreeRssMb } from '../benchmarks/support/process-tree.ts'

interface Options {
  readonly label: string
  readonly maxTreeRssMb: number
  readonly command: string
  readonly args: readonly string[]
}

const POLL_MS = 100

if (process.platform !== 'linux') {
  throw new Error('coding-agent benchmarks require Linux')
}

const options = parseOptions(process.argv.slice(2))
const child = spawn(options.command, [...options.args], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'inherit',
  env: { ...process.env, DSH_BENCHMARK_LABEL: options.label },
})

if (child.pid === undefined) throw new Error(`benchmark ${options.label} did not receive a process id`)

let peakRssMb = 0
let overLimit: boolean | undefined
const monitor = setInterval(() => {
  void processTreeRssMb(child.pid as number).then((rssMb) => {
    peakRssMb = Math.max(peakRssMb, rssMb)
    if (rssMb <= options.maxTreeRssMb || overLimit === true) return
    overLimit = true
    process.stderr.write(
      `benchmark ${options.label} exceeded its ${String(options.maxTreeRssMb)} MiB process-tree RSS ceiling `
      + `at ${String(Math.round(rssMb))} MiB\n`,
    )
    terminateProcessGroup(child.pid as number)
  }).catch(() => {})
}, POLL_MS)

const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => { resolve({ code, signal }) })
})
clearInterval(monitor)
const finalRssMb = await processTreeRssMb(child.pid).catch(() => 0)
peakRssMb = Math.max(peakRssMb, finalRssMb)
process.stdout.write(
  `benchmark safety ${JSON.stringify({
    label: options.label,
    maxTreeRssMb: options.maxTreeRssMb,
    peakTreeRssMb: Math.round(peakRssMb),
    exitCode: result.code,
    signal: result.signal,
    safetyFailure: overLimit === true,
  })}\n`,
)
if (overLimit === true) process.exitCode = 137
else if (result.signal !== null) process.exitCode = 1
else process.exitCode = result.code ?? 1

function parseOptions(args: readonly string[]): Options {
  const separator = args.indexOf('--')
  if (separator < 0) throw new Error('usage: run-benchmark --label <name> --max-tree-rss-mb <MiB> -- <command> [args...]')
  const before = args.slice(0, separator)
  const command = args[separator + 1]
  if (command === undefined) throw new Error('benchmark command is missing')
  const label = optionValue(before, '--label')
  const maxTreeRssMb = Number(optionValue(before, '--max-tree-rss-mb'))
  if (label.length === 0 || !Number.isSafeInteger(maxTreeRssMb) || maxTreeRssMb <= 0) {
    throw new Error('benchmark label and positive integer RSS ceiling are required')
  }
  return { label, maxTreeRssMb, command, args: args.slice(separator + 2) }
}

function optionValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]
  if (value === undefined) throw new Error(`missing ${name}`)
  return value
}

function terminateProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch { /* the child already exited */ }
  }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* the group already exited */ }
  }, 1_000).unref()
}
