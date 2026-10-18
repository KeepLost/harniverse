/** The paste-import parser: OpenCode `mcp`, standard `mcpServers`, and the shared KEY=VALUE line codec. */

import { describe, expect, it } from 'vitest'
import { formatKeyValueLines, McpImportError, parseKeyValueLines, parseMcpImport } from '../src/client/import.ts'

describe('parseKeyValueLines', () => {
  it('splits KEY=VALUE lines, skipping blanks and comments', () => {
    expect(parseKeyValueLines('A=1\n\nB=hello world\n# note')).toEqual({ A: '1', B: 'hello world' })
  })

  it('trims keys and values, keeps an empty value as the keep-secret marker, and rejects malformed lines', () => {
    expect(parseKeyValueLines('  A = 1 ')).toEqual({ A: '1' })
    expect(parseKeyValueLines('EMPTY=')).toEqual({ EMPTY: '' })
    expect(parseKeyValueLines('')).toEqual({})
    expect(() => parseKeyValueLines('=1')).toThrow(McpImportError)
    expect(() => parseKeyValueLines('BROKEN')).toThrow(McpImportError)
  })
})

describe('formatKeyValueLines', () => {
  it('round-trips a parsed map back to sorted lines', () => {
    expect(formatKeyValueLines({ B: '2', A: '1' })).toBe('A=1\nB=2')
    expect(parseKeyValueLines(formatKeyValueLines({ X: 'y' }))).toEqual({ X: 'y' })
  })
})

describe('parseMcpImport', () => {
  it('reads OpenCode mcp JSON with local and remote servers', () => {
    const parsed = parseMcpImport(JSON.stringify({
      mcp: {
        filesystem: { type: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { ROOT: '/tmp' }, cwd: '/tmp', enabled: true },
        search: { type: 'remote', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer x' } },
      },
    }))
    expect(parsed).toHaveLength(2)
    const fs = parsed.find(server => server.id === 'filesystem')
    expect(fs).toMatchObject({
      id: 'filesystem',
      serverName: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { ROOT: '/tmp' },
      cwd: '/tmp',
    })
    const search = parsed.find(server => server.id === 'search')
    expect(search).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer x' } })
  })

  it('reads the standard mcpServers shape (command/url without type fields)', () => {
    const parsed = parseMcpImport(JSON.stringify({
      mcpServers: {
        git: { command: 'git-mcp', args: ['--stdio'] },
        docs: { url: 'https://docs.example/mcp' },
      },
    }))
    expect(parsed.map(server => [server.id, server.transport])).toEqual([['git', 'stdio'], ['docs', 'streamable-http']])
  })

  it('reads a single bare server entry as a one-row import', () => {
    expect(parseMcpImport(JSON.stringify({ url: 'https://one.example/mcp' }))).toHaveLength(1)
  })

  it('rejects entries that are neither command nor url', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcp: { broken: { env: {} } } }))).toThrow(McpImportError)
  })

  it('rejects non-object JSON, non-object roots, and empty parses with the same error type', () => {
    expect(() => parseMcpImport('not json')).toThrow(McpImportError)
    expect(() => parseMcpImport('[]')).toThrow(McpImportError)
    expect(() => parseMcpImport('null')).toThrow(McpImportError)
    expect(() => parseMcpImport('{}')).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcp: {} }))).toThrow(McpImportError)
  })

  it('rejects OpenCode type values other than local/remote', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcp: { odd: { type: 'carrier-pigeon', command: 'x' } } }))).toThrow(McpImportError)
  })

  it('rejects non-object env and headers maps and non-string entry values', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', env: 'nope' } } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { url: 'https://x', headers: 7 } } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', env: [] } } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', env: { N: 3 } } } }))).toThrow(McpImportError)
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', env: null } } }))[0]).toMatchObject({ env: {} })
  })

  it('rejects names that sanitize to nothing and accepts sanitized names', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcp: { '   ': { type: 'remote', url: 'https://x' } } }))).toThrow(McpImportError)
    expect(parseMcpImport(JSON.stringify({ mcp: { 'my server!': { type: 'remote', url: 'https://x' } } }))[0]).toMatchObject({ id: 'my_server_', serverName: 'my_server_' })
  })

  it('requires a url on remote OpenCode entries', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcp: { a: { type: 'remote' } } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcp: { a: { type: 'remote', url: '' } } }))).toThrow(McpImportError)
  })

  it('falls back to the command when a standard url is empty or non-string and accepts array commands', () => {
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { url: 5, command: 'x' } } }))[0]).toMatchObject({ transport: 'stdio', command: 'x' })
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { url: '', command: ['x', 'y'] } } }))[0]).toMatchObject({ transport: 'stdio', command: 'x', args: ['y'] })
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { url: '', command: [] } } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { url: '', command: 3 } } }))).toThrow(McpImportError)
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', cwd: 5, args: ['ok', 2] } } }))[0]).toMatchObject({ cwd: '', args: ['ok'] })
    expect(parseMcpImport(JSON.stringify({ mcp: { a: { type: 'local', command: ['x', 3] } } }))[0]).toMatchObject({ args: [] })
  })

  it('rejects a standard entry with neither command nor url', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { broken: { env: {} } } }))).toThrow(McpImportError)
  })

  it('reads a string cwd from a standard entry', () => {
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', cwd: '/w' } } }))[0]).toMatchObject({ cwd: '/w' })
  })

  it('accepts a bare numeric root as not-an-object rejection', () => {
    expect(() => parseMcpImport('3')).toThrow(McpImportError)
    expect(() => parseMcpImport('true')).toThrow(McpImportError)
  })

  it('ignores non-string cwd and args entries', () => {
    expect(parseMcpImport(JSON.stringify({ mcpServers: { a: { command: 'x', cwd: 5, args: ['ok', 2] } } }))[0]).toMatchObject({ cwd: '', args: ['ok'] })
    expect(parseMcpImport(JSON.stringify({ mcp: { a: { type: 'local', command: ['x', 3] } } }))[0]).toMatchObject({ args: [] })
  })

  it('rejects non-object entries and containers', () => {
    expect(() => parseMcpImport(JSON.stringify({ mcp: { a: 3 } }))).toThrow(McpImportError)
    expect(() => parseMcpImport(JSON.stringify({ mcp: [] }))).toThrow(McpImportError)
  })

  it('reads a bare entry with only a command and one keyed by mcpServers', () => {
    expect(parseMcpImport(JSON.stringify({ command: 'solo' }))[0]).toMatchObject({ id: 'imported', command: 'solo' })
    expect(parseMcpImport(JSON.stringify({ mcpServers: { s: { command: 'x' } } }))[0]).toMatchObject({ id: 's' })
  })
})
