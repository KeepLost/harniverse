/**
 * M6 product-wiring evidence against a real QEMU microvm through the real
 * app boot chain: an explicit `$DSH_EXEC_WORLD=vm` mounts the vm capability
 * family end to end — the world service boots, bash resolves and executes
 * inside the guest with the argv the bash tool composes, the fs seam
 * round-trips a file through the world's `/workspace`, and the unset
 * permission default composes the recorded world-boundary posture. The
 * second boot pins an explicit confined mode and asserts the in-guest
 * Landlock enforcement both sides of the boundary. Skips without a usable
 * binary or staged assets (CI lanes
 * provision neither); the stub-based loader suite owns CI coverage.
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

interface ExecWorldE2EReport {
  publishedEnv: string | undefined
  subprocessLocality: 'local' | 'remote' | undefined
  fsProvider: string | undefined
  sandboxProvider: string | undefined
  vmService: string | undefined
  policyMode: string | undefined
  bashPath?: string
  bashExit?: number | null
  bashKernel?: string
  fsRoundTrip?: string
  confineArgv?: string[]
  confineInside?: { code: number | null; stderr: string }
  confineOutside?: { code: number | null; stderr: string }
  resolvedMode?: string
  cwdMappedPwd?: { code: number | null; pwd: string }
  cwdForeign?: string
  hostImportRoot?: string
  hostImportNested?: string
}

async function runE2E(env: Record<string, string>): Promise<ExecWorldE2EReport> {
  let report: ExecWorldE2EReport | undefined
  await runLoaderSmoke({
    label: 'exec-world real composition e2e',
    tempDirPrefix: 'exec-world-e2e-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    env,
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'exec-world-e2e-report.json'), 'utf8')) as ExecWorldE2EReport
    },
  })
  if (report === undefined) throw new Error('exec-world e2e driver wrote no report')
  return report
}

describe.skipIf(!worldAvailable)('exec-world against a real QEMU composition', () => {
  it('mounts the vm family and runs the tool shapes inside the world', { timeout: 120_000 }, async () => {
    const report = await runE2E({ DSH_EXEC_WORLD: 'vm' })
    expect(report).toMatchObject({
      publishedEnv: 'vm',
      subprocessLocality: 'remote',
      fsProvider: 'VmFileSystem',
      sandboxProvider: 'VmSandboxProvider',
      vmService: 'QemuLocalWorld',
      policyMode: 'danger-full-access',
      bashPath: '/bin/bash',
      bashExit: 0,
      fsRoundTrip: 'exec-world round trip\n',
    })
    expect(report.bashKernel).toMatch(/^kernel=\d+\.\d+\.\d+.*-virt/)
    expect(report.cwdMappedPwd).toEqual({ code: 0, pwd: '/workspace/nested' })
    expect(report.cwdForeign).toContain('outside the host workspace root')
  })

  it('imports the anchored host workspace into /workspace at boot', { timeout: 120_000 }, async () => {
    const report = await runE2E({
      DSH_EXEC_WORLD: 'vm',
      DSH_VM_HOST_IMPORT_E2E: '1',
      DSH_VM_HOST_WORKSPACE_ROOT: fileURLToPath(new URL('./fixtures/host-workspace', import.meta.url)),
    })
    expect(report.hostImportRoot).toBe('host import round trip')
    expect(report.hostImportNested).toBe('nested')
  })

  it('enforces an explicitly pinned confined mode inside the world', { timeout: 120_000 }, async () => {
    const report = await runE2E({ DSH_EXEC_WORLD: 'vm', DSH_PERMISSION_MODE: 'workspace-write' })
    expect(report.resolvedMode).toBe('workspace-write')
    expect(report.confineArgv).toEqual([
      '/bin/dsh-vm-confine', '--ro', '/',
      '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/workspace',
      '--', 'bash', '-c', 'true',
    ])
    expect(report.confineInside?.code).toBe(0)
    expect(report.confineOutside?.code).not.toBe(0)
    expect(report.confineOutside?.stderr).toMatch(/permission denied/i)
  })
})

void LOADER_SMOKE_TEST_TIMEOUT_MS
