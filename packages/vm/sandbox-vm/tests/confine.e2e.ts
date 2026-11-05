/**
 * M7 confinement evidence against a real QEMU microvm through the real app
 * boot chain: the guest announces the Landlock backend, and the confined
 * modes keep their file-effect matrix inside the world — every write
 * outside the granted roots denies with the EACCES dialect while reads and
 * the granted sinks pass, and an in-world-nonexistent workspace root fails
 * closed as a wrapper runner failure instead of a silent pass-through.
 * Skips without a usable binary or staged assets (CI lanes provision
 * neither); the stub-based loader suite owns CI coverage.
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

interface Outcome {
  code: number | null
  stderr: string
}

interface SandboxVmE2EReport {
  guestConfinement: string | undefined
  subprocessLocality: 'local' | 'remote' | undefined
  readOnlyWriteEtc: Outcome
  readOnlyWriteWorkspace: Outcome
  readOnlyReadEtc: Outcome
  readOnlyDevNull: Outcome
  workspaceWriteWorkspace: Outcome
  workspaceWriteTmp: Outcome
  workspaceWriteEtc: Outcome
  workspaceWriteReadEtc: Outcome
  runnerFailureBadRoot: Outcome
}

async function runE2E(): Promise<SandboxVmE2EReport> {
  let report: SandboxVmE2EReport | undefined
  await runLoaderSmoke({
    label: 'sandbox-vm real composition e2e',
    tempDirPrefix: 'sandbox-vm-e2e-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'sandbox-vm-e2e-report.json'), 'utf8')) as SandboxVmE2EReport
    },
  })
  if (report === undefined) throw new Error('sandbox-vm e2e driver wrote no report')
  return report
}

describe.skipIf(!worldAvailable)('sandbox-vm against a real QEMU composition', () => {
  it('enforces the confined-mode file-effect matrix inside the world', { timeout: 180_000 }, async () => {
    const report = await runE2E()
    expect(report.guestConfinement).toBe('landlock')
    expect(report.subprocessLocality).toBe('remote')
    const denied = (outcome: Outcome): void => {
      expect(outcome.code).not.toBe(0)
      expect(outcome.stderr).toMatch(/permission denied/i)
    }
    const allowed = (outcome: Outcome): void => {
      expect(outcome.code).toBe(0)
    }
    denied(report.readOnlyWriteEtc)
    denied(report.readOnlyWriteWorkspace)
    allowed(report.readOnlyReadEtc)
    allowed(report.readOnlyDevNull)
    allowed(report.workspaceWriteWorkspace)
    allowed(report.workspaceWriteTmp)
    denied(report.workspaceWriteEtc)
    allowed(report.workspaceWriteReadEtc)
    expect(report.runnerFailureBadRoot.code).toBe(3)
    expect(report.runnerFailureBadRoot.stderr).toContain('dsh-vm-confine:')
  })
})

void LOADER_SMOKE_TEST_TIMEOUT_MS
