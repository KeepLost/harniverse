import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { exposeScopedServer } from '../src/exposure.ts'
import type { ScopedServerInventory } from '../src/exposure.ts'
import { registerServerContext } from '../src/server-context.ts'

it('publishes unrestricted literal instructions and resources until the owner unloads', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  const fiber = ctx.plugin((inner) => {
    registerServerContext(inner, 'docs', 'default-owner', {
      instructions: () => 'Literal {{server instruction}}',
      resources: { request: async () => ({ resources: [{ uri: 'docs://guide', name: 'Guide' }] }) },
    })
  })
  try {
    await fiber
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Literal {{server instruction}}')
    const request = {
      name: 'list_mcp_resources', arguments: { server: 'docs' },
      callId: CallId('default-visibility'), signal: new AbortController().signal,
    }
    const result = await ctx.tools.execute(request)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('docs://guide')
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Literal {{server instruction}}')
    expect((await ctx.tools.execute(request)).isError).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
})

/** Minimal always-connected inventory carrying literal instructions. */
function inventory(instructions: string): ScopedServerInventory {
  return {
    toolNames: () => [],
    connected: () => true,
    resourceUris: () => [],
    resourceTemplates: () => [],
    instructions: () => instructions,
    resources: { request: async () => ({}) },
  }
}

it('keeps one instruction section per server under a shared reservation owner', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  const docs = ctx.plugin(inner => exposeScopedServer(inner, 'docs', 'shared-owner', inventory('Docs instructions.')))
  const notes = ctx.plugin(inner => exposeScopedServer(inner, 'notes', 'shared-owner', inventory('Notes instructions.')))
  try {
    await Promise.all([docs, notes])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Docs instructions.')
    expect(prompt).toContain('Notes instructions.')
    await notes.dispose()
    const afterDispose = renderPrompt(await ctx.systemPrompt.assemble())
    expect(afterDispose).toContain('Docs instructions.')
    expect(afterDispose).not.toContain('Notes instructions.')
  } finally {
    await ctx.fiber.dispose()
  }
})
