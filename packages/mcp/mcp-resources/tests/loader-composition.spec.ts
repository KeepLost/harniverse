// Proves the shared resource tools and server-name prompt section are real
// composition facts: the runtime boots through the real Loader against a
// Loader-mounted cordis.yml, and a provider registered on the booted context
// surfaces model-visible tools, prompt text, and routed reads.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpResources from '../src/index.ts'

let root = ''
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-resources-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-mcp-resources'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-mcp-resources', McpResources],
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

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('mcp-resources real Loader composition through cordis.yml', () => {
  it('publishes the shared tools, prompt section, and routed reads for a booted provider', async () => {
    const ctx = await boot()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')

    const remove = ctx.mcpResources.register('docs', {
      request: async () => ({ contents: [{ uri: 'docs://guide', mimeType: 'text/plain', text: 'Read me.' }] }),
    })
    const names = ctx.tools.schemas().map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('server argument: ["docs"]')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-read'),
      name: 'read_mcp_resource',
      arguments: { server: 'docs', uri: 'docs://guide' },
    })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('MCP server: docs')
    expect(resultText(result)).toContain('Read me.')

    remove()
    expect(ctx.tools.get('read_mcp_resource')).toBeUndefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')
  }, 30_000)
})
