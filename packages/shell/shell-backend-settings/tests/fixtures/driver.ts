#!/usr/bin/env node
/**
 * Test driver: boot the shellBackend Loader composition (settings provider
 * seeded with `git-bash`, both shell stacks ungated) and persist the observed
 * composition facts to `./shell-backend-loader-report.json` for the package
 * spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('shell-backend driver requires a config path')

const ctx = await boot('shell-backend-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const described = ctx.settings.describe().find(entry => entry.ns === 'shell-backend')
  const toolNames = ctx.tools.schemas().map(tool => tool.name)
  await writeFile('./shell-backend-loader-report.json', JSON.stringify({
    nsApplies: described?.applies,
    publishedEnv: process.env.DSH_SHELL_BACKEND,
    shellService: ctx.get('shell')?.constructor?.name,
    hasBashTool: toolNames.includes('bash'),
    hasPwshTool: toolNames.includes('pwsh'),
  }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
