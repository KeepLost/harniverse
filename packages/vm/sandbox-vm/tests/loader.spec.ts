/**
 * REAL-composition tier (packages/AGENTS.md): boot the package's Loader
 * fixture as a subprocess through the same app/boot path a deployment uses,
 * and assert the whole chain end to end — the session-resolved policy (a
 * guest cwd boundary) flows into the provider, the wrap composes the
 * in-guest Landlock wrapper argv with the recorded grant spelling, and a
 * world that proves no backend still fails closed with the honest
 * refusal. The vm side rides the fixture's stub world so the suite passes
 * on hosts without a VM provider; the QEMU-gated e2e boots the real
 * provider.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface SandboxVmLoaderReport {
  mode: string | undefined
  workspaceRoot: string | undefined
  guestConfinement: string | undefined
  confineArgv?: string[]
  enforcement?: string
  denialSignatures?: string[]
  confineError?: string
}

async function runCase(env?: Record<string, string>): Promise<SandboxVmLoaderReport> {
  let report: SandboxVmLoaderReport | undefined
  await runLoaderSmoke({
    label: 'sandbox-vm loader smoke',
    tempDirPrefix: 'sandbox-vm-loader-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    ...env === undefined ? {} : { env },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'sandbox-vm-loader-report.json'), 'utf8')) as SandboxVmLoaderReport
    },
  })
  if (report === undefined) throw new Error('sandbox-vm loader driver wrote no report')
  return report
}

describe('sandbox-vm through a real Loader composition', () => {
  it('wraps argv with the in-guest Landlock wrapper under the session policy', async () => {
    const report = await runCase()
    expect(report.mode).toBe('workspace-write')
    // The session cwd boundary flows through the platform's root resolver
    // (a drive-prefixed spelling on win32); the wrap carries exactly it.
    const { workspaceRoot } = report
    expect(workspaceRoot).toBeDefined()
    expect(report.guestConfinement).toBe('landlock')
    expect(report.confineArgv).toEqual([
      '/bin/dsh-vm-confine', '--ro', '/',
      '--rw', '/dev/null', '--rw', '/tmp', '--rw', workspaceRoot,
      '--', 'bash', '-c', 'ls',
    ])
    expect(report.enforcement).toBe('full')
    expect(report.denialSignatures).toEqual(['permission denied'])
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('fails closed with the honest refusal when the world proves no backend', async () => {
    const report = await runCase({ DSH_STUB_GUEST_CONFINEMENT: 'none' })
    expect(report.guestConfinement).toBe('none')
    expect(report.confineArgv).toBeUndefined()
    expect(report.confineError).toContain('the world guest reports no in-guest confinement backend')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
