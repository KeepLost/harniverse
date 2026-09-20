/**
 * Tests for the MCP resource identity, visibility, and refresh contract.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyMcpRefresh,
  isMcpResourceIdentity,
  isMcpServerName,
  MCP_SERVER_NAME_PATTERN,
  mcpResourceMemberId,
  mcpServerCapabilityId,
  resolveMcpMemberVisibility,
} from '@deepseek-ai/dsh-mcp-client'

describe('server and resource identity', () => {
  it('accepts only names inside the reserved namespace budget', () => {
    expect(isMcpServerName('files')).toBe(true)
    expect(isMcpServerName('a-b_C9')).toBe(true)
    expect(isMcpServerName('')).toBe(false)
    expect(isMcpServerName('has space')).toBe(false)
    expect(isMcpServerName('x'.repeat(33))).toBe(false)
    expect('files').toMatch(MCP_SERVER_NAME_PATTERN)
  })

  it('guards resource identities and derives stable capability ids', () => {
    expect(isMcpResourceIdentity({ serverName: 'files', uri: 'file:///a.txt' })).toBe(true)
    expect(isMcpResourceIdentity({ serverName: 'bad name', uri: 'x' })).toBe(false)
    expect(isMcpResourceIdentity({ serverName: 'files', uri: '' })).toBe(false)
    expect(isMcpResourceIdentity(null)).toBe(false)
    const serverId = mcpServerCapabilityId('files')
    expect(serverId).toBe(`mcp-server:${Buffer.from('files').toString('hex')}`)
    expect(mcpResourceMemberId('files', 'file:///a.txt')).toBe(`${serverId}/mcp-resource:${Buffer.from('file:///a.txt').toString('hex')}`)
    expect(mcpResourceMemberId('files', 'file:///a.txt')).toBe(mcpResourceMemberId('files', 'file:///a.txt'))
  })
})

describe('resolveMcpMemberVisibility', () => {
  const tools = ['read', 'write']
  const resources = ['file:///a.txt', 'file:///b.txt']

  it('denies every member of an unselected server', () => {
    const visibility = resolveMcpMemberVisibility({ selected: false }, tools, resources)
    expect(visibility).toEqual({
      serverSelected: false,
      visibleToolNames: [],
      visibleResourceUris: [],
      deniedToolNames: tools,
      deniedResourceUris: resources,
    })
  })

  it('admits everything a selected server reports without explicit member selection', () => {
    const visibility = resolveMcpMemberVisibility({ selected: true }, tools, resources)
    expect(visibility.visibleToolNames).toEqual(tools)
    expect(visibility.visibleResourceUris).toEqual(resources)
    expect(visibility.deniedToolNames).toEqual([])
    expect(visibility.deniedResourceUris).toEqual([])
  })

  it('narrows to exactly the allowlist members marked visible', () => {
    const visibility = resolveMcpMemberVisibility({
      selected: true,
      memberEntries: [
        { id: 't1', kind: 'mcp-tool', name: 'read', description: '', defaultVisible: true, available: true, requires: [], visible: true },
        { id: 't2', kind: 'mcp-tool', name: 'write', description: '', defaultVisible: true, available: true, requires: [], visible: false },
        { id: 'r1', kind: 'mcp-resource', name: 'file:///a.txt', description: '', defaultVisible: true, available: true, requires: [], visible: true },
        { id: 'r2', kind: 'mcp-resource', name: 'file:///b.txt', description: '', defaultVisible: true, available: true, requires: [], visible: false },
      ],
    }, tools, resources)
    expect(visibility.visibleToolNames).toEqual(['read'])
    expect(visibility.deniedToolNames).toEqual(['write'])
    expect(visibility.visibleResourceUris).toEqual(['file:///a.txt'])
    expect(visibility.deniedResourceUris).toEqual(['file:///b.txt'])
  })
})

describe('classifyMcpRefresh', () => {
  it('keeps topology refreshes inside the captured generation', () => {
    expect(classifyMcpRefresh('reconnect')).toBe('topology')
    expect(classifyMcpRefresh('tool-sync')).toBe('topology')
    expect(classifyMcpRefresh('member-change')).toBe('composition')
    expect(classifyMcpRefresh('selection-change')).toBe('composition')
  })
})
