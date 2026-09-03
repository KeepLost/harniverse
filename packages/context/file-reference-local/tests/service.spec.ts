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

async function scopedAgentOf(ctx: Context): Promise<{
  agent: Agent
  dispose: () => void
  scope: ReturnType<Context['plugin']>
}> {
  const root = await mkdtemp(join(tmpdir(), 'harniverse-file-reference-scoped-agent-'))
  roots.push(root)
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId('file-reference-scoped-agent'), { meta: { cwd: root } })
  const agent = { id: session.id, options: {}, session, status: 'idle', ctx: scope.ctx } as unknown as Agent
  return { agent, dispose: ctx.agents.register(agent), scope }
}

describe('LocalFileReferenceService', () => {
  it('searches the Agent cwd and exposes read guidance only when read is visible', async () => {
    const ctx = await harness()
    const { agent } = await agentOf(ctx)
    await ctx.plugin(LocalFileReferenceService)
    await expect(ctx.fileReferences.list(agent, 'README', new AbortController().signal)).resolves.toEqual([{ path: 'README.md', kind: 'file' }])
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
    ctx.emit('session/event', agent.session, { type: 'assistant/message' } as never)
    const unknownSession = ctx.sessions.create(SessionId('file-reference-unknown-session'))
    ctx.emit('session/event', unknownSession, { type: 'tool/result' } as never)
  })

  it('applies explicit bounds and cleans up the provider cache', async () => {
    const ctx = await harness()
    const { agent } = await agentOf(ctx)
    const fiber = await ctx.plugin(LocalFileReferenceService, { maxResults: 1, maxEntries: 1, excludedDirectories: [] })
    await expect(ctx.fileReferences.list(agent, '', new AbortController().signal)).resolves.toHaveLength(1)
    await fiber.dispose()
  })

  it('uses the process cwd when the Agent session has no cwd', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin(LocalFileReferenceService)
    const session = ctx.sessions.create(SessionId('file-reference-no-cwd'))
    const agent = { id: session.id, options: {}, session, status: 'idle', ctx } as unknown as Agent
    const dispose = ctx.agents.register(agent)
    await expect(ctx.fileReferences.list(agent, 'missing/', new AbortController().signal)).resolves.toEqual([])
    dispose()
    await fiber.dispose()
  })

  it('installs prompt guidance for later Agents and tolerates repeated lifecycle events', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin(LocalFileReferenceService)
    const { agent, dispose } = await agentOf(ctx)
    ctx.emit('agent/created', { agent })
    ctx.emit('agent/disposed', { agent })
    ctx.emit('agent/disposed', { agent })
    dispose()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects invalid direct constructor configuration', async () => {
    for (const config of [
      { maxResults: 0 },
      { maxEntries: 0 },
      { excludedDirectories: ['nested/path'] },
    ]) {
      const ctx = new Context()
      expect(() => new LocalFileReferenceService(ctx, config)).toThrow('file-reference-local')
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['an Error', new Error('fiber teardown refused'), 'fiber teardown refused'],
    ['a non-Error', 'fiber teardown refused', 'fiber teardown refused'],
  ])('warns without failing Agent disposal when prompt cleanup rejects with %s', async (_name, reason, text) => {
    const ctx = await harness()
    const { agent, dispose } = await agentOf(ctx)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    await ctx.plugin(LocalFileReferenceService)
    const service = ctx.fileReferences as unknown as { promptFibers: Map<Agent, { dispose: () => unknown }> }
    const fiber = service.promptFibers.get(agent)
    if (fiber === undefined) throw new Error('the Agent must own a prompt fiber')
    // Teardown of the prompt section is best-effort: its failure is reported and
    // must not propagate into Agent disposal.
    vi.spyOn(fiber, 'dispose').mockReturnValue(Promise.reject(reason))

    expect(() => { dispose() }).not.toThrow()
    await vi.waitFor(() => {
      expect(warnings.join('\n')).toContain(`file-reference-local: prompt cleanup failed: ${text}`)
    })
    await ctx.fiber.dispose()
  })

  it('does not warn when an Agent scope already disposed its prompt fiber', async () => {
    const ctx = await harness()
    const { dispose, scope } = await scopedAgentOf(ctx)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    await ctx.plugin(LocalFileReferenceService)

    await scope.dispose()
    dispose()

    expect(warnings).toEqual([])
    await ctx.fiber.dispose()
  })
})
