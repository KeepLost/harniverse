/**
 * REAL-composition tier (packages/AGENTS.md): boot the package's Loader
 * fixture as a subprocess through the same app/boot path a deployment uses,
 * and assert the whole chain end to end — the seeded `exec-world:` user
 * document (or the explicit env escape hatch) flows through the boot bridge
 * into `$DSH_EXEC_WORLD`, exactly one capability family mounts, and the
 * permission-mode default follows the recorded vm-world composition decision.
 * The vm side rides the fixture's stub world so the suite passes on hosts
 * without a VM provider; the QEMU-gated e2e boots the real provider.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface ExecWorldLoaderReport {
  nsApplies: 'live' | 'restart' | undefined
  publishedEnv: string | undefined
  anchor: string | undefined
  cwdMapped: string | undefined
  cwdForeign: string | undefined
  subprocessLocality: 'local' | 'remote' | undefined
  fsProvider: string | undefined
  sandboxProvider: string | undefined
  vmService: string | undefined
  hasBashTool: boolean
  policyMode: string | undefined
}

async function runCase(options: {
  seed?: string
  env?: Record<string, string>
}): Promise<{ report: ExecWorldLoaderReport | undefined; stderr: string }> {
  let report: ExecWorldLoaderReport | undefined
  const seed = options.seed
  const prepare = seed === undefined ? undefined : async (cwd: string): Promise<void> => {
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh', 'settings.yaml'), seed)
  }
  const { stderr } = await runLoaderSmoke({
    label: 'exec-world loader smoke',
    tempDirPrefix: 'exec-world-loader-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    ...options.env === undefined ? {} : { env: options.env },
    ...prepare === undefined ? {} : { prepare },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'exec-world-loader-report.json'), 'utf8')) as ExecWorldLoaderReport
    },
  })
  return { report, stderr }
}

describe('exec-world through a real Loader composition', () => {
  it('composes the local family by default with the confined permission default', async () => {
    const { report, stderr } = await runCase({})
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      nsApplies: 'restart',
      publishedEnv: 'local',
      subprocessLocality: 'local',
      hasBashTool: true,
      policyMode: 'workspace-write',
    })
    expect(report?.vmService).toBeUndefined()
    expect(report?.fsProvider).not.toBe('VmFileSystem')
    expect(report?.sandboxProvider).not.toBe('VmSandboxProvider')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('mounts the vm family under an explicit env override with the world-boundary default', async () => {
    const { report, stderr } = await runCase({ env: { DSH_EXEC_WORLD: 'vm' } })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      publishedEnv: 'vm',
      subprocessLocality: 'remote',
      fsProvider: 'VmFileSystem',
      sandboxProvider: 'VmSandboxProvider',
      vmService: 'StubVmWorld',
      hasBashTool: true,
      policyMode: 'danger-full-access',
    })
    expect(report?.anchor).toBeDefined()
    expect(report?.cwdMapped).toBe('/workspace/a.ts')
    expect(report?.cwdForeign).toContain('outside the host workspace root')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps an explicit local override over a seeded vm document', async () => {
    const { report, stderr } = await runCase({ seed: 'exec-world:\n  world: vm\n', env: { DSH_EXEC_WORLD: 'local' } })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      publishedEnv: 'local',
      subprocessLocality: 'local',
      policyMode: 'workspace-write',
    })
    expect(report?.vmService).toBeUndefined()
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
