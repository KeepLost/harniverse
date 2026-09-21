/**
 * Real-composition coverage for the W07 MCP runtime surfaces: server
 * instructions, shared resource tools, and resource reads over the REAL MCP
 * stdio protocol. The fixture server (`resource-fixture-server.ts`) is
 * keyless and local, so every assertion here is model-visible output through
 * a genuine composition.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const resourceServerPath = fileURLToPath(new URL('./resource-fixture-server.ts', import.meta.url))

const config: Config = {
  transport: 'stdio',
  serverName: 'res',
  command: process.execPath,
  args: [resourceServerPath],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: true,
}

let ctx: Context

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  await apply(ctx, config)
}, 60_000)

afterAll(async () => {
  await ctx.fiber.dispose()
})

describe('MCP instructions and resources through a real stdio server', () => {
  it('publishes the attributed server instructions verbatim in the system prompt', async () => {
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('### MCP server: res\n\nServe documentation resources. Literal braces {{stay literal}}.')
    expect(prompt).toContain('## MCP resource servers')
    expect(prompt).toContain('server argument: ["res"]')
  })

  it('lists the discovered resources and templates through the shared tools', async () => {
    const list = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('list-resources'),
      name: 'list_mcp_resources',
      arguments: { server: 'res' },
    })
    expect(list.isError).toBe(false)
    const text = JSON.stringify(list.content)
    expect(text).toContain('docs://binary')
    expect(text).toContain('docs://guide')
    expect(text).toContain('config://app')
  })

  it('reads text and binary resources, masking binary bytes in model history', async () => {
    const text = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-text'),
      name: 'read_mcp_resource',
      arguments: { server: 'res', uri: 'docs://guide' },
    })
    expect(text.isError).toBe(false)
    expect(JSON.stringify(text.content)).toContain('Read this guide.')
    expect(JSON.stringify(text.content)).not.toContain('[binary resource')

    const binary = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-binary'),
      name: 'read_mcp_resource',
      arguments: { server: 'res', uri: 'docs://binary' },
    })
    expect(binary.isError).toBe(false)
    expect(JSON.stringify(binary.content)).toContain('[binary resource: 8 base64 characters; available to programmatic callers]')
    expect(JSON.stringify(binary.content)).not.toContain('AQIDBA==')
  })

  it('reads a plain config resource URI end to end', async () => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-config'),
      name: 'read_mcp_resource',
      arguments: { server: 'res', uri: 'config://app' },
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('key=value')
  })

  it('rejects a read while the server is disconnected', async () => {
    const offline = new Context()
    await offline.plugin(SystemPrompt)
    await offline.plugin(ToolRuntime)
    await offline.plugin(McpResources)
    // A server process that speaks enough MCP to connect then dies: `echo`
    // exits immediately, so the first sync fails fast with startup failure
    // contained and the connection reports disconnected.
    await apply(offline, {
      ...config,
      failOnStartupError: false,
      command: 'echo',
      args: [],
    })
    const result = await offline.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-offline'),
      name: 'read_mcp_resource',
      arguments: { server: 'res', uri: 'docs://guide' },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('server is disconnected')
    await offline.fiber.dispose()
  })
})
