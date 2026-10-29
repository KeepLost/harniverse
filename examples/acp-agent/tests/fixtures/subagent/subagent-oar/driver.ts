#!/usr/bin/env node
/** Inspect the OAR provider and tool composition without invoking them. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('subagent-oar Loader composition driver requires a config path')
}

let starts = 0
const ctx = await boot(
  'subagent-oar-loader-composition',
  resolveConfigPath(configPath, undefined),
  undefined,
  (hostCtx) => {
    hostCtx.on('subagent/start', () => {
      starts += 1
    })
  },
)

try {
  const providers = ['oar-codex', 'oar-claude'].map((name) => {
    const provider = ctx.subagents.getProvider(name)
    if (provider === undefined) {
      throw new Error(`${name} provider was not registered`)
    }
    return {
      name: provider.name,
      capabilities: provider.capabilities,
      inheritsParentContext: provider.inheritsParentContext,
    }
  })
  const tool = ctx.tools.schemas().find(schema => schema.name === 'subagent_oar')
  if (tool === undefined) throw new Error('subagent_oar tool was not registered')
  const properties = tool.parameters.properties
  if (
    typeof properties !== 'object'
    || properties === null
    || Array.isArray(properties)
  ) {
    throw new Error('subagent_oar has invalid parameter properties')
  }
  const tools = [{
    name: tool.name,
    parameterNames: Object.keys(properties).sort(),
    required: tool.parameters.required,
  }]

  process.stdout.write(`${JSON.stringify({ providers, tools, starts })}\n`)
} finally {
  await ctx.fiber.dispose()
}
