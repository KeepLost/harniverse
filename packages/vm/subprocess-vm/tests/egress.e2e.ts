/**
 * M8 egress evidence against a real QEMU microvm through the real app boot
 * chain: the approval-attributed child reaches a host echo server through
 * the in-guest SOCKS proxy after one approval card per destination (the
 * second dial to a cached destination asks nothing), refusals fail the
 * dial inside the world, and an unattributed exec denies by default. Skips
 * without a usable binary or staged assets (CI lanes provision neither);
 * the stub-based loader suite owns CI coverage.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { probeWorld } from '@deepseek-ai/dsh-vm-qemu-local'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

const driver = fileURLToPath(new URL('./fixtures/driver-real.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis-real.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface EgressE2EReport {
  verdict: string
  approvedExit?: number
  approvedStdout?: string
  approvedAsks?: number
  unattributedExit?: number
  unattributedAsks?: number
  deniedExit?: number
  deniedAsks?: number
}

async function runE2E(env?: Record<string, string>): Promise<EgressE2EReport> {
  let report: EgressE2EReport | undefined
  await runLoaderSmoke({
    label: 'subprocess-vm egress e2e',
    tempDirPrefix: 'subprocess-vm-egress-e2e-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    ...env === undefined ? {} : { env },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'subprocess-vm-egress-report.json'), 'utf8')) as EgressE2EReport
    },
  })
  if (report === undefined) throw new Error('egress e2e driver wrote no report')
  return report
}

describe.skipIf(!worldAvailable)('subprocess-vm egress against a real QEMU composition', () => {
  it('approves once per destination, caches the session, and denies unattributed dials', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    const report = await runE2E({ DSH_STUB_APPROVAL: 'allow' })
    expect(report.approvedExit).toBe(0)
    expect(report.approvedStdout).toBe('all-ok')
    // Three dials, two distinct destinations: two cards, the cached one asks nothing.
    expect(report.approvedAsks).toBe(2)
    expect(report.unattributedExit).not.toBe(0)
    expect(report.unattributedAsks).toBe(2)
  })

  it('fails the dial inside the world when the card is refused', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    const report = await runE2E({ DSH_STUB_APPROVAL: 'deny' })
    expect(report.deniedExit).not.toBe(0)
    expect(report.deniedAsks).toBe(1)
  })
})
