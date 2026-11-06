#!/usr/bin/env node
/**
 * Test driver: boot the subprocess-vm Loader composition (real
 * user-questions service with a scripted provider, stub agents, stub
 * world), spawn one child to bind an egress origin to the live initiator,
 * simulate guest dials through the recorded approver, and persist the
 * verdicts — approvals, per-session caching, unattributed default-deny —
 * to `./subprocess-vm-loader-report.json` for the package spec's inspect
 * step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { StubVmWorld } from './stub-world.ts'
import { askCount } from './stub-questions.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('subprocess-vm driver requires a config path')

const ctx = await boot('subprocess-vm-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const world = ctx.vm as StubVmWorld
  const spawned = ctx.subprocess.spawn({
    argv: ['sh', '-c', 'sleep 5'],
    cwd: '/',
    graceMs: 2_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
  })
  const origin = world.lastSpawn?.options?.origin
  const report: Record<string, unknown> = {
    bound: origin !== undefined,
    verdict: process.env.DSH_STUB_APPROVAL ?? 'no-provider',
    asks: () => askCount.current,
    firstDial: await world.dial(origin, 'api.example', 443),
  }
  const askCountAfterFirst = askCount.current
  const cachedDial = await world.dial(origin, 'api.example', 443)
  report.cachedDial = cachedDial
  report.cacheAvoidedSecondAsk = askCount.current === askCountAfterFirst
  report.otherDestination = await world.dial(origin, 'api.example', 8443)
  report.unattributedDenied = !(await world.dial(undefined, 'api.example', 443))
  world.lastSpawn?.settle({ code: 0, signal: null })
  await spawned.done
  await writeFile('./subprocess-vm-loader-report.json', JSON.stringify({
    ...report,
    asks: askCount.current,
  }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
