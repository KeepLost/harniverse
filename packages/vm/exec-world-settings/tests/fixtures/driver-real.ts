#!/usr/bin/env node
/**
 * QEMU-gated e2e driver: boot the execWorld composition with the REAL
 * provider (cordis-real.yml), drive the world's seams with the exact shapes
 * the bash/fs tools compose, and persist the observed facts to
 * `./exec-world-e2e-report.json` for the spec's inspect step. The confined
 * run (DSH_PERMISSION_MODE pinned to a confined mode) composes the in-guest
 * Landlock backend and asserts both sides of the boundary.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('exec-world e2e driver requires a config path')

const ctx = await boot('exec-world-e2e', resolveConfigPath(configPath, undefined))
try {
  const report: Record<string, unknown> = {
    publishedEnv: process.env.DSH_EXEC_WORLD,
    subprocessLocality: ctx.get('subprocess')?.locality,
    fsProvider: ctx.get('fs')?.constructor?.name,
    sandboxProvider: ctx.get('sandbox')?.constructor?.name,
    vmService: ctx.get('vm')?.constructor?.name,
    policyMode: ctx.get('sandboxPolicy')?.defaultMode,
  }

  if (process.env.DSH_PERMISSION_MODE === undefined) {
    // The world-boundary run: bash resolves and runs inside the guest, and
    // the fs seam round-trips a file into the world's /workspace.
    const bashPath = await ctx.subprocess.resolveExecutable('bash')
    const spawned = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'printf "kernel=%s\\n" "$(uname -r)"'],
      cwd: '/workspace',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    })
    const outcome = await spawned.done
    report.bashPath = bashPath
    report.bashExit = outcome.exitCode
    report.bashKernel = spawned.collected.stdout?.readFrom(0).text.trim()
    const target = await ctx.fs.resolve('/workspace/m6-e2e.txt')
    // The world-boundary posture a vm session resolves (the deployment
    // default under this boot); passing it explicitly mirrors the per-call
    // policy a session with a guest cwd supplies.
    await ctx.fs.writeText(target, 'exec-world round trip\n', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    report.fsRoundTrip = await ctx.fs.readText(await ctx.fs.resolve('/workspace/m6-e2e.txt'))
    // The boot-time host-workspace import: with the marker set, the boot's
    // anchor pointed at the committed fixture tree, so both of its files must
    // already sit inside /workspace when the world settles.
    if (process.env.DSH_VM_HOST_IMPORT_E2E === '1') {
      report.hostImportRoot = await ctx.fs.readText(await ctx.fs.resolve('/workspace/from-host.txt'))
      report.hostImportNested = await ctx.fs.readText(await ctx.fs.resolve('/workspace/nested/deep.txt'))
    }

    // The session-cwd mapping: a host cwd under the boot anchor (this
    // driver's launch directory) runs in-world at /workspace/<rel>, and a
    // host cwd outside the anchor fails closed with the mapping diagnosis.
    const anchor = process.env.DSH_VM_HOST_WORKSPACE_ROOT
    if (anchor !== undefined) {
      const prep = await (async () => {
        const spawned = ctx.subprocess.spawn({
          argv: ['bash', '-c', 'mkdir -p /workspace/nested'],
          cwd: '/workspace',
          graceMs: 5_000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        })
        return (await spawned.done).exitCode
      })().catch(() => -1)
      const mapped = prep === 0
        ? await (async () => {
          const spawned = ctx.subprocess.spawn({
            argv: ['bash', '-c', 'printf "%s" "$PWD"'],
            cwd: `${anchor}/nested`,
            graceMs: 5_000,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
          })
          const outcome = await spawned.done
          return { code: outcome.exitCode, pwd: spawned.collected.stdout?.readFrom(0).text }
        })().catch((error: unknown) => ({ code: -1, pwd: `error: ${error instanceof Error ? error.message : String(error)}` }))
        : { code: prep, pwd: 'prep failed' }
      report.cwdMappedPwd = mapped
      const foreign = await (async () => {
        const spawned = ctx.subprocess.spawn({
          argv: ['bash', '-c', 'true'],
          cwd: '/definitely-outside-the-anchor',
          graceMs: 5_000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        })
        await spawned.done
        return 'spawned'
      })().catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`.split('\n')[0])
      report.cwdForeign = foreign
    }
  } else {
    // The confined run: an explicit mode under the vm world composes the
    // in-guest Landlock backend — the wrap carries the guest wrapper, the
    // write inside the boundary passes, and the write outside it denies
    // with the EACCES dialect. A guest session cwd supplies the
    // workspace-write boundary the remote world requires.
    const policy = ctx.get('sandboxPolicy')!.resolve({ session: { header: { cwd: '/workspace' }, events: [], id: 'exec-world-e2e' } as never })
    const confined = await ctx.sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: policy.workspaceRoot })
    report.confineArgv = confined.argv
    const wrap = async (command: string): Promise<string[]> => {
      const wrapped = await ctx.sandbox.confine(['bash', '-c', command], { mode: 'workspace-write', workspaceRoot: policy.workspaceRoot })
      return wrapped.argv
    }
    const run = async (command: string) => {
      const spawned = ctx.subprocess.spawn({
        argv: await wrap(command),
        cwd: '/workspace',
        graceMs: 10_000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      })
      const outcome = await spawned.done
      return { code: outcome.exitCode, stderr: spawned.collected.stderr?.readFrom(0).text ?? '' }
    }
    report.confineInside = await run('echo x > /workspace/m6-confined-ok.txt')
    report.confineOutside = await run('echo x > /etc/m6-confined-deny')
    report.resolvedMode = policy.mode
  }

  await writeFile('./exec-world-e2e-report.json', JSON.stringify(report, null, 2))
} finally {
  await ctx.fiber.dispose()
}
