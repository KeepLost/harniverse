import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import type { ConnectionHandle } from '../src/connection.ts'

const { transportFactory } = vi.hoisted(() => ({ transportFactory: vi.fn() }))
vi.mock('../src/transport.ts', () => ({ createTransport: transportFactory }))

let ctx: Context | undefined
let connection: ConnectionHandle | undefined
let peer: InMemoryTransport | undefined
afterEach(async () => {
  await connection?.dispose()
  await peer?.close()
  await ctx?.fiber.dispose()
})

async function connect(version: string) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const [transport, server] = InMemoryTransport.createLinkedPair()
  peer = server
  const setProtocolVersion = vi.fn()
  Object.assign(transport, { setProtocolVersion })
  transportFactory.mockReturnValue(transport)
  const methods: string[] = []
  server.onmessage = (message) => {
    if (!('method' in message)) return
    methods.push(message.method)
    if (!('id' in message)) return
    const result = message.method === 'initialize'
      ? { protocolVersion: version, capabilities: { resources: {} }, serverInfo: { name: 'peer', version: '1' }, instructions: 'Literal {{data}}. \n' }
      : message.method === 'resources/list' ? { resources: [{ name: 'Guide', uri: 'docs://guide' }] }
        : message.method === 'resources/templates/list' ? { resourceTemplates: [{ name: 'Search', uriTemplate: 'docs://search/{query}' }] }
          : { contents: [{ uri: 'docs://guide', text: 'Guide body.' }] }
    void server.send({ jsonrpc: '2.0', id: message.id, result })
  }
  await server.start()
  connection = startConnection(ctx, {
    transport: 'stdio', serverName: 'peer', command: 'unused', args: [], env: {}, cwd: '',
    toolCallTimeoutMs: 1_000, failOnStartupError: true,
  }, resolveReconnectPolicy({ enabled: false }, 'test'))
  return { outcome: await connection.ready, methods, setProtocolVersion, connection }
}

describe('real SDK protocol boundary', () => {
  it('accepts a supported negotiated version and initializes a resource-only peer', async () => {
    const version = SUPPORTED_PROTOCOL_VERSIONS.at(-1)!
    const result = await connect(version)
    expect(result.outcome).toEqual({})
    expect(result.setProtocolVersion).toHaveBeenCalledWith(version)
    expect(result.methods).toEqual(['initialize', 'notifications/initialized', 'resources/list', 'resources/templates/list'])
    expect(result.connection.connected()).toBe(true)
    expect(result.connection.resourceUris()).toEqual(['docs://guide'])
    expect(result.connection.resourceTemplates()).toEqual(['docs://search/{query}'])
    expect(result.connection.instructions()).toBe('### MCP server: peer\n\nLiteral {{data}}. \n')
  })

  it('rejects an unsupported protocol before discovery or publishing instructions', async () => {
    const result = await connect('unsupported-version')
    expect(String(result.outcome.error)).toContain('protocol version is not supported')
    expect(result.methods).toEqual(['initialize'])
    expect(result.setProtocolVersion).not.toHaveBeenCalled()
    expect(result.connection.connected()).toBe(false)
    expect(result.connection.instructions()).toBe('')
    expect(result.connection.resourceUris()).toEqual([])
  })
})
