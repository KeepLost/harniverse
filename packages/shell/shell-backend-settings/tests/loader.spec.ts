/**
 * REAL-composition tier (packages/AGENTS.md): boot the package's Loader fixture
 * as a subprocess through the same app/boot path a deployment uses, and assert
 * the whole chain end to end — the seeded `shell-backend:` user document flows
 * through the boot bridge into `$DSH_SHELL_BACKEND`, and the symmetric flag
 * pair mounts exactly the selected stack. On a non-win32 host the second case
 * pins the flag flip itself by overriding the env value to `pwsh`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface ShellBackendLoaderReport {
  nsApplies: 'live' | 'restart' | undefined
  publishedEnv: string | undefined
  shellService: string | undefined
  hasBashTool: boolean
  hasPwshTool: boolean
}

async function runCase(options: {
  seed?: string
  env?: Record<string, string>
}): Promise<{ report: ShellBackendLoaderReport | undefined; stderr: string }> {
  let report: ShellBackendLoaderReport | undefined
  const seed = options.seed
  const prepare = seed === undefined ? undefined : async (cwd: string): Promise<void> => {
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh', 'settings.yaml'), seed)
  }
  const { stderr } = await runLoaderSmoke({
    label: 'shell-backend loader smoke',
    tempDirPrefix: 'shell-backend-loader-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    ...options.env === undefined ? {} : { env: options.env },
    ...prepare === undefined ? {} : { prepare },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'shell-backend-loader-report.json'), 'utf8')) as ShellBackendLoaderReport
    },
  })
  return { report, stderr }
}

describe('shell-backend through a real Loader composition', () => {
  it('follows the seeded git-bash document into the bash stack', async () => {
    const { report, stderr } = await runCase({ seed: 'shell-backend:\n  backend: git-bash\n' })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      nsApplies: 'restart',
      publishedEnv: 'bash',
      shellService: 'SandboxBashExecutor',
      hasBashTool: true,
      hasPwshTool: false,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('mounts the pwsh stack under an explicit env override', async () => {
    const { report, stderr } = await runCase({ env: { DSH_SHELL_BACKEND: 'pwsh' } })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      publishedEnv: 'pwsh',
      shellService: 'SandboxPwshExecutor',
      hasBashTool: false,
      hasPwshTool: true,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
