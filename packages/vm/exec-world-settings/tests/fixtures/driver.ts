#!/usr/bin/env node
/**
 * Test driver: boot the execWorld Loader composition (settings provider
 * seeded with `exec-world:`, capability-family rows gated on the published
 * `$DSH_EXEC_WORLD`) and persist the observed composition facts to
 * `./exec-world-loader-report.json` for the package spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('exec-world driver requires a config path')

const ctx = await boot('exec-world-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const described = ctx.settings.describe().find(entry => entry.ns === 'exec-world')
  const toolNames = ctx.tools.schemas().map(tool => tool.name)
  const fs = ctx.get('fs')
  const anchor = process.env.DSH_VM_HOST_WORKSPACE_ROOT ?? process.cwd()
  const cwdMapped = await fs?.resolve('a.ts', { cwd: anchor }).then(target => target.displayPath, (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
  const cwdForeign = await fs?.resolve('a.ts', { cwd: '/definitely-outside-the-anchor' }).then(target => target.displayPath, (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
  await writeFile('./exec-world-loader-report.json', JSON.stringify({
    nsApplies: described?.applies,
    publishedEnv: process.env.DSH_EXEC_WORLD,
    anchor,
    cwdMapped,
    cwdForeign,
    subprocessLocality: ctx.get('subprocess')?.locality,
    fsProvider: ctx.get('fs')?.constructor?.name,
    sandboxProvider: ctx.get('sandbox')?.constructor?.name,
    vmService: ctx.get('vm')?.constructor?.name,
    hasBashTool: toolNames.includes('bash'),
    policyMode: ctx.get('sandboxPolicy')?.defaultMode,
  }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
