import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
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
