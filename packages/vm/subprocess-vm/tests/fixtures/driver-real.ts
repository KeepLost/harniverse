#!/usr/bin/env node
/**
 * Real-composition e2e driver: boot the QEMU world with its guest egress
 * surface open, spawn the approval-attributed child whose bash dials the
 * injected SOCKS proxy over /dev/tcp against a host echo server, and
 * persist the verdicts — approval card, per-session cache, refusals, and
 * the unattributed default-deny — to `./subprocess-vm-egress-report.json`.
 */

import { createServer } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { askCount } from './stub-questions.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('egress e2e driver requires a config path')

/** bash dials the injected SOCKS proxy n times through /dev/tcp. */
const DIALS = `
port=\${ALL_PROXY##*:}
dial() {
  exec 3<>/dev/tcp/127.0.0.1/$port || return 9
  printf '\\x05\\x01\\x00' >&3
  head -c 2 <&3 >/dev/null
  printf '\\x05\\x01\\x00\\x03\\x09' >&3
  printf '%s' '127.0.0.1' >&3
  printf "\\x$(printf %02x $(($1>>8&255)))\\x$(printf %02x $(($1&255)))" >&3
  head -c 10 <&3 >/dev/null
  printf 'ping' >&3
  out=$(head -c 9 <&3)
  exec 3<&-
  test "$out" = "echo:ping"
}
dial $DSH_ECHO_PORT || exit 1
dial $DSH_ECHO_PORT || exit 2
dial $DSH_OTHER_PORT || exit 3
echo all-ok
`

const SINGLE_DIAL = `
port=\${ALL_PROXY##*:}
exec 3<>/dev/tcp/127.0.0.1/$port || exit 9
printf '\\x05\\x01\\x00' >&3
head -c 2 <&3 >/dev/null
printf '\\x05\\x01\\x00\\x03\\x09' >&3
printf '%s' '127.0.0.1' >&3
printf "\\x$(printf %02x $((DSH_ECHO_PORT>>8&255)))\\x$(printf %02x $((DSH_ECHO_PORT&255)))" >&3
head -c 10 <&3 >/dev/null
printf 'ping' >&3
out=$(head -c 9 <&3)
test "$out" = "echo:ping"
`

const echo = createServer((socket) => {
  socket.on('data', (chunk: Buffer) => { socket.write(Buffer.concat([Buffer.from('echo:'), chunk])) })
})
await new Promise<void>((resolve) => { echo.listen(0, '127.0.0.1', () => { resolve() }) })
const echoPort = (echo.address() as { port: number }).port
const other = createServer((socket) => {
  socket.on('data', (chunk: Buffer) => { socket.write(Buffer.concat([Buffer.from('echo:'), chunk])) })
})
await new Promise<void>((resolve) => { other.listen(0, '127.0.0.1', () => { resolve() }) })
const otherPort = (other.address() as { port: number }).port

const env = {
  PATH: '/bin:/usr/bin:/sbin:/usr/sbin',
  DSH_ECHO_PORT: String(echoPort),
  DSH_OTHER_PORT: String(otherPort),
}

const ctx = await boot('subprocess-vm-egress-e2e', resolveConfigPath(configPath, undefined))
const report: Record<string, unknown> = { verdict: process.env.DSH_STUB_APPROVAL ?? 'no-provider' }
try {
  if (process.env.DSH_STUB_APPROVAL === 'deny') {
    const denied = ctx.subprocess.spawn({
      argv: ['bash', '-c', SINGLE_DIAL],
      cwd: '/',
      env,
      graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 1_000 } },
    })
    const deniedOutcome = await denied.done
    report.deniedExit = deniedOutcome.exitCode
    report.deniedAsks = askCount.current
  } else {
    const spawned = ctx.subprocess.spawn({
      argv: ['bash', '-c', DIALS],
      cwd: '/',
      env,
      graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 1_000 } },
    })
    const outcome = await spawned.done
    report.approvedExit = outcome.exitCode
    report.approvedStdout = spawned.collected.stdout?.readFrom(0).text.trim()
    report.approvedAsks = askCount.current

    // An exec with no origin stays unattributed: the world denies its dials.
    const bare = await ctx.vm.exec(['bash', '-c', SINGLE_DIAL], { env, timeoutMs: 30_000 })
    report.unattributedExit = bare.code
    report.unattributedAsks = askCount.current
  }
  await writeFile('./subprocess-vm-egress-report.json', JSON.stringify(report, null, 2))
} finally {
  await ctx.fiber.dispose()
  echo.close()
  other.close()
}
