#!/usr/bin/env node
/**
 * Test driver: boot the sandbox-vm Loader composition (stub world plus the
 * shared policy service), confine the exact argv shape the bash tool
 * composes under the session-resolved policy, and persist the wrap — or the
 * honest refusal when the stub world proves no backend — to
 * `./sandbox-vm-loader-report.json` for the package spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('sandbox-vm driver requires a config path')

const ctx = await boot('sandbox-vm-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const policy = ctx.get('sandboxPolicy')!.resolve({ session: { header: { cwd: '/workspace' }, events: [], id: 'sandbox-vm-loader' } as never })
  const report: Record<string, unknown> = {
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
    guestConfinement: ctx.vm.descriptor.guestConfinement,
  }
  try {
    const confined = await ctx.sandbox.confine(['bash', '-c', 'ls'], policy as SandboxPolicy)
    report.confineArgv = confined.argv
    report.enforcement = confined.enforcement
    report.denialSignatures = confined.denialSignatures
  } catch (error) {
    report.confineError = error instanceof Error ? error.message : String(error)
  }
  await writeFile('./sandbox-vm-loader-report.json', JSON.stringify(report, null, 2))
} finally {
  await ctx.fiber.dispose()
}
