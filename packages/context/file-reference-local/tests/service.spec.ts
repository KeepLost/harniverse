import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import LocalFileReferenceService, { WorkspaceFileSearch } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

async function agentOf(ctx: Context): Promise<{ agent: Agent; dispose: () => void }> {
  const root = await mkdtemp(join(tmpdir(), 'harniverse-file-reference-service-'))
  roots.push(root)
  await writeFile(join(root, 'README.md'), 'readme')
  const session = ctx.sessions.create(SessionId('file-reference-agent'), { meta: { cwd: root } })
  const agent = { id: session.id, options: {}, session, status: 'idle', ctx } as unknown as Agent
  return { agent, dispose: ctx.agents.register(agent) }
}

describe('LocalFileReferenceService', () => {
  it('searches the Agent cwd and exposes read guidance only when read is visible', async () => {
    const ctx = await harness()
    const { agent } = await agentOf(ctx)
    await ctx.plugin(LocalFileReferenceService)
    await expect(ctx.fileReferences.list(agent, 'README', new AbortController().signal)).resolves.toEqual([{ path: 'README.md', kind: 'file' }])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(FILE_REFERENCE_PROMPT)
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, execute: () => Promise.resolve([]) }))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(FILE_REFERENCE_PROMPT)
  })

  it('publishes the observation capability on its Remote method', async () => {
    const ctx = await harness()
    await ctx.plugin(LocalFileReferenceService)
    expect(remoteMethods(ctx.fileReferences)).toContainEqual({
      method: 'remoteExportList', exportName: 'list', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe',
    })
  })

  it('invalidates an Agent cache on tool results and disposes the cache', async () => {
    const ctx = await harness()
    const { agent, dispose } = await agentOf(ctx)
    const invalidate = vi.spyOn(WorkspaceFileSearch.prototype, 'invalidate')
    const close = vi.spyOn(WorkspaceFileSearch.prototype, 'dispose')
    await ctx.plugin(LocalFileReferenceService)
    await ctx.fileReferences.list(agent, '', new AbortController().signal)
    ctx.emit('session/event', agent.session, { type: 'tool/result' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    ctx.emit('session/event', agent.session, { type: 'assistant/message' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    dispose()
    expect(close).toHaveBeenCalledOnce()
  })
})
