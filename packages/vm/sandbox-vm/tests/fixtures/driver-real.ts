#!/usr/bin/env node
/**
 * QEMU-gated e2e driver: boot the sandbox-vm composition with the REAL
 * provider, then run the confined-mode semantic matrix — the same
 * confine-then-spawn composition the bash tool uses — against the live
 * guest. Persists one outcome per matrix cell to
 * `./sandbox-vm-e2e-report.json` for the spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('sandbox-vm e2e driver requires a config path')

interface Outcome {
  code: number | null
  stderr: string
}

async function runConfined(ctx: Awaited<ReturnType<typeof boot>>, policy: SandboxPolicy, command: string): Promise<Outcome> {
  const confined = await ctx.sandbox.confine(['bash', '-c', command], policy)
  const spawned = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: '/workspace',
    graceMs: 10_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await spawned.done
  return { code: outcome.exitCode, stderr: spawned.collected.stderr?.readFrom(0).text ?? '' }
}

const ctx = await boot('sandbox-vm-e2e', resolveConfigPath(configPath, undefined))
try {
  const report: Record<string, unknown> = {
    guestConfinement: ctx.vm.descriptor.guestConfinement,
    subprocessLocality: ctx.get('subprocess')?.locality,
  }
  const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/workspace' }
  const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace' }
  report.readOnlyWriteEtc = await runConfined(ctx, readOnly, 'echo x > /etc/m7-deny')
  report.readOnlyWriteWorkspace = await runConfined(ctx, readOnly, 'echo x > /workspace/m7-deny')
  report.readOnlyReadEtc = await runConfined(ctx, readOnly, 'cat /etc/passwd > /dev/null')
  report.readOnlyDevNull = await runConfined(ctx, readOnly, 'echo x > /dev/null')
  report.workspaceWriteWorkspace = await runConfined(ctx, workspaceWrite, 'echo x > /workspace/m7-ok.txt')
  report.workspaceWriteTmp = await runConfined(ctx, workspaceWrite, 'echo x > /tmp/m7-ok.txt')
  report.workspaceWriteEtc = await runConfined(ctx, workspaceWrite, 'echo x > /etc/m7-deny')
  report.workspaceWriteReadEtc = await runConfined(ctx, workspaceWrite, 'cat /etc/passwd > /dev/null')
  // A workspace root that does not exist inside the world must surface as
  // a wrapper runner failure (fail-closed), never as a silent pass-through.
  report.runnerFailureBadRoot = await runConfined(ctx, { mode: 'workspace-write', workspaceRoot: '/no-such-root' }, 'true')
  await writeFile('./sandbox-vm-e2e-report.json', JSON.stringify(report, null, 2))
} finally {
  await ctx.fiber.dispose()
}
