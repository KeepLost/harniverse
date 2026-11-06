/**
 * REAL-composition tier (packages/AGENTS.md): boot the package's Loader
 * fixture as a subprocess through the same app/boot path a deployment
 * uses, and assert the whole egress approval chain end to end — the spawn
 * binds an origin to the live initiator, guest dials flow through the
 * real user-questions service to the scripted provider, approvals cache
 * per session, and a dial without an approval source (no provider) or
 * without attribution denies by default. The vm side rides the fixture's
 * stub world so the suite passes on hosts without a VM provider; the
 * QEMU-gated e2e boots the real provider.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface EgressLoaderReport {
  bound: boolean
  verdict: string
  asks: number
  firstDial: boolean
  cachedDial: boolean
  cacheAvoidedSecondAsk: boolean
  otherDestination: boolean
  unattributedDenied: boolean
}

async function runCase(env?: Record<string, string>): Promise<EgressLoaderReport> {
  let report: EgressLoaderReport | undefined
  await runLoaderSmoke({
    label: 'subprocess-vm egress loader smoke',
    tempDirPrefix: 'subprocess-vm-loader-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    ...env === undefined ? {} : { env },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'subprocess-vm-loader-report.json'), 'utf8')) as EgressLoaderReport
    },
  })
  if (report === undefined) throw new Error('subprocess-vm loader driver wrote no report')
  return report
}

describe('subprocess-vm egress approval through a real Loader composition', () => {
  it('approves through the user-questions card and caches per session', async () => {
    const report = await runCase({ DSH_STUB_APPROVAL: 'allow' })
    expect(report.bound).toBe(true)
    expect(report.firstDial).toBe(true)
    expect(report.cachedDial).toBe(true)
    expect(report.cacheAvoidedSecondAsk).toBe(true)
    expect(report.otherDestination).toBe(true)
    expect(report.unattributedDenied).toBe(true)
    expect(report.asks).toBe(2)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('denies refusals and keeps every dial default-denied without a provider', async () => {
    const denied = await runCase({ DSH_STUB_APPROVAL: 'deny' })
    expect(denied.firstDial).toBe(false)
    expect(denied.cachedDial).toBe(false)
    expect(denied.unattributedDenied).toBe(true)
    // Refusals are not remembered: each dial asks again (three dials, three cards).
    expect(denied.asks).toBe(3)

    const unprovisioned = await runCase()
    expect(unprovisioned.bound).toBe(true)
    expect(unprovisioned.firstDial).toBe(false)
    expect(unprovisioned.unattributedDenied).toBe(true)
    expect(unprovisioned.asks).toBe(0)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
