#!/usr/bin/env node
/** Test driver: one ACP-mode turn through a headless Loader composition. */

import { writeFileSync } from 'node:fs'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const configPath = process.argv[2]
const report = process.env.DSH_TEST_REPORT
if (configPath === undefined || report === undefined) throw new Error('the ACP composition driver needs a config path and DSH_TEST_REPORT')

const ctx = await boot('agent-acp-composition', resolveConfigPath(configPath, undefined))
try {
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('acp-main'),
    meta: { cwd: process.cwd(), agentProfile: 'acp' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'acp')
    },
  })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello from the harness' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  const events = handle.agent.session.events
  writeFileSync(report, JSON.stringify({
    types: events.filter(event => !event.type.startsWith('agent/inbox/')).map(event => event.type),
    messages: events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content),
    entered: events.filter(event => event.type === 'user/message').map(event => event.data.source.kind),
  }))
} finally {
  await ctx.fiber.dispose()
}
