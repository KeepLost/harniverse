// Proves the notice policy is real Loader composition and not unit-test
// wiring: a cordis.yml booted through the real Loader delivers a non-waking
// notice whose threshold came from the yml config block.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as ContextNudge from '@deepseek-ai/dsh-context-nudge'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { UserMessage } from '@deepseek-ai/dsh-session'

const SOURCE = '@deepseek-ai/dsh-context-nudge'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a cordis.yml carrying the given context-nudge config block. */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-nudge-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-context-nudge'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-context-nudge', ContextNudge],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('context-nudge loader composition', () => {
  it('delivers a config-driven notice through the real Loader composition', async () => {
    const ctx = await boot([
      '    thresholdTokens: 64',
      '    refireDeltaTokens: 32',
    ])
    ctx.tools.register(defineContentToolFixture({
      name: 'context_compact',
      description: 'Compact older conversation history.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    const notices: UserMessage[] = []
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'plugin' && message.source.plugin === SOURCE) notices.push(message)
    })
    const agent = ctx.agentLoop.create(SessionId('loader-nudge'), { provider: 'mock', model: 'mock' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'well above the configured threshold '.repeat(32) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    expect(agent.status).toBe('idle')
    const source = notices[0]!.source as { form?: string; thresholdTokens?: number }
    expect(source.form).toBe('system-injection')
    expect(source.thresholdTokens).toBe(64)
  })
})
