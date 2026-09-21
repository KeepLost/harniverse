/**
 * Minimal MCP server with instructions and resources over stdio for testing
 * the dsh-mcp-client resource and instruction surfaces.
 *
 * Run: node resource-fixture-server.ts
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer(
  { name: 'resource-fixture-server', version: '1.0.0' },
  {
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    instructions: 'Serve documentation resources. Literal braces {{stay literal}}.',
  },
)

server.registerTool('ping', {
  description: 'Answers pong.',
  inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: 'pong' }] }))

server.resource('guide', 'docs://guide', async () => ({
  contents: [{ uri: 'docs://guide', mimeType: 'text/plain', text: 'Read this guide.' }],
}))

server.resource('binary', 'docs://binary', async () => ({
  contents: [{ uri: 'docs://binary', mimeType: 'application/octet-stream', blob: 'AQIDBA==' }],
}))

server.resource('config', 'config://app', async () => ({
  contents: [{ uri: 'config://app', mimeType: 'text/plain', text: 'key=value' }],
}))

server.resource('search', new ResourceTemplate('docs://search/{query}', { list: undefined }), async uri => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Results for the templated query.' }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
