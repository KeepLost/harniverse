#!/usr/bin/env node
/** Test driver: one delegation turn through a headless Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('subagent-peer loader driver requires a config path')

const ctx = await boot('subagent-peer-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'delegate' })
} finally {
  await ctx.fiber.dispose()
}
