/**
 * MCP resource identity, visibility, and refresh contract: how a resource
 * belongs to one server, how Profile member selection narrows what an
 * assembled Agent may reach, and which refreshes stay inside a running
 * Session's captured capability generation. Pure rules — the resource
 * discovery that feeds them ships with the MCP resource runtime.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { CapabilityCatalogEntry } from '@deepseek-ai/dsh-capabilities'

/** Valid `serverName`: the namespace every server-qualified identity builds on. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Whether a candidate server name fits the reserved public namespace budget.
 * @param name - the candidate server name.
 * @returns whether the name matches {@link MCP_SERVER_NAME_PATTERN}.
 */
export function isMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_PATTERN.test(name)
}

/** One resource owned by one MCP server: the server's stable name plus the server-issued resource URI. */
export interface McpResourceIdentity {
  readonly serverName: string
  readonly uri: string
}

/**
 * Type guard for {@link McpResourceIdentity}: valid server name and non-empty URI.
 * @param value - the candidate identity, unvalidated.
 * @returns whether the value is a well-formed resource identity.
 */
export function isMcpResourceIdentity(value: unknown): value is McpResourceIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<McpResourceIdentity>
  return typeof candidate.serverName === 'string' && isMcpServerName(candidate.serverName)
    && typeof candidate.uri === 'string' && candidate.uri.length > 0
}

/**
 * Stable capability id of one MCP server, matching the adapter's `mcp-server:<hex>` convention.
 * @param serverName - the server's validated public name.
 * @returns the server's capability id.
 */
export function mcpServerCapabilityId(serverName: string): string {
  return `mcp-server:${Buffer.from(serverName).toString('hex')}`
}

/**
 * Stable capability member id of one MCP resource, mirroring the `mcp-tool:<hex>` convention.
 * @param serverName - the owning server's validated public name.
 * @param uri - the server-issued resource URI.
 * @returns the resource's capability member id.
 */
export function mcpResourceMemberId(serverName: string, uri: string): string {
  return `${mcpServerCapabilityId(serverName)}/mcp-resource:${Buffer.from(uri).toString('hex')}`
}

/**
 * Stable identity distinct from a concrete resource with the same spelling.
 * @param serverName - owning server's public name.
 * @param template - server-issued URI template.
 * @returns the template member id.
 */
export function mcpResourceTemplateMemberId(serverName: string, template: string): string {
  return `${mcpServerCapabilityId(serverName)}/mcp-resource-template:${Buffer.from(template).toString('hex')}`
}

/** Members of one server an assembled Agent may reach, narrowed by Profile selection. */
export interface McpMemberVisibility {
  /** The server itself is selected; when false every member is denied. */
  readonly serverSelected: boolean
  /** The captured server grant has no explicit resource member restriction. */
  readonly unrestrictedResources: boolean
  /** Tool names visible to the assembled Agent. */
  readonly visibleToolNames: readonly string[]
  /** Resource URIs visible to the assembled Agent. */
  readonly visibleResourceUris: readonly string[]
  /** Resource URI templates visible to the assembled Agent. */
  readonly visibleResourceTemplates: readonly string[]
  /** Tool names the composition must deny. */
  readonly deniedToolNames: readonly string[]
  /** Resource URIs the composition must deny. */
  readonly deniedResourceUris: readonly string[]
  /** Resource URI templates the composition must deny. */
  readonly deniedResourceTemplates: readonly string[]
}

/**
 * Resolve member visibility for one `mcp-server` catalog entry against the
 * discovered inventory: an unselected server denies every member; a selected
 * server with an explicit member allowlist admits exactly its captured ids,
 * including ids inherited from global settings. A narrowed Profile cannot reach an excluded server's
 * tools or resources through the shared client. A selected server without an
 * explicit member selection admits everything the server currently reports.
 * @param entry - the resolved catalog entry of one MCP server capability.
 * @param toolNames - every tool name the server currently reports.
 * @param resourceUris - every resource URI the server currently reports.
 * @param resourceTemplates - every URI template the server currently reports.
 * @returns the members an assembled Agent may reach and the ones to deny.
 */
export function resolveMcpMemberVisibility(
  entry: Pick<CapabilityCatalogEntry, 'selected' | 'memberEntries' | 'memberSelection' | 'memberAllowlist'> & Partial<Pick<CapabilityCatalogEntry, 'name'>>,
  toolNames: readonly string[],
  resourceUris: readonly string[],
  resourceTemplates: readonly string[] = [],
): McpMemberVisibility {
  if (!entry.selected) {
    return {
      serverSelected: false,
      unrestrictedResources: false,
      visibleToolNames: [],
      visibleResourceUris: [],
      visibleResourceTemplates: [],
      deniedToolNames: [...toolNames],
      deniedResourceUris: [...resourceUris],
      deniedResourceTemplates: [...resourceTemplates],
    }
  }
  const allowlist = entry.memberAllowlist
  const serverName = entry.name ?? ''
  const members = allowlist === undefined ? entry.memberEntries?.map(member => ({
    ...member,
    kind: member.id === mcpResourceTemplateMemberId(serverName, member.name) ? 'mcp-template' : member.kind,
  })) : [
    ...toolNames.map(name => ({ name, kind: 'mcp-tool', visible: allowlist.includes(`${mcpServerCapabilityId(serverName)}/mcp-tool:${Buffer.from(name).toString('hex')}`) })),
    ...resourceUris.map(name => ({ name, kind: 'mcp-resource', visible: allowlist.includes(mcpResourceMemberId(serverName, name)) })),
    ...resourceTemplates.map(name => ({ name, kind: 'mcp-template', visible: allowlist.includes(mcpResourceTemplateMemberId(serverName, name)) })),
  ]
  const unrestrictedResources = allowlist === undefined && (members === undefined || entry.memberSelection === 'inherit')
  if (members === undefined || unrestrictedResources) {
    return {
      serverSelected: true,
      unrestrictedResources,
      visibleToolNames: [...toolNames],
      visibleResourceUris: [...resourceUris],
      visibleResourceTemplates: [...resourceTemplates],
      deniedToolNames: [],
      deniedResourceUris: [],
      deniedResourceTemplates: [],
    }
  }
  const visibleTools: string[] = []
  const visibleResources: string[] = []
  const visibleTemplates: string[] = []
  for (const member of members) {
    if (!member.visible) continue
    if (member.kind === 'mcp-tool' && toolNames.includes(member.name)) visibleTools.push(member.name)
    if (member.kind === 'mcp-resource' && resourceUris.includes(member.name)) visibleResources.push(member.name)
    if (member.kind === 'mcp-template' && resourceTemplates.includes(member.name)) visibleTemplates.push(member.name)
  }
  return {
    serverSelected: true,
    unrestrictedResources,
    visibleToolNames: visibleTools,
    visibleResourceUris: visibleResources,
    visibleResourceTemplates: visibleTemplates,
    deniedToolNames: toolNames.filter(name => !visibleTools.includes(name)),
    deniedResourceUris: resourceUris.filter(uri => !visibleResources.includes(uri)),
    deniedResourceTemplates: resourceTemplates.filter(uri => !visibleTemplates.includes(uri)),
  }
}

/** What kind of refresh one MCP change triggers. */
export type McpRefreshKind = 'topology' | 'composition'

/** Concrete triggers the MCP surfaces produce. */
export type McpRefreshTrigger = 'reconnect' | 'tool-sync' | 'member-change' | 'selection-change'

/**
 * Classify one refresh trigger. `'topology'` (reconnect, tool/resource sync)
 * bumps the catalog's topology revision through adapter invalidation and
 * never changes a running Session's captured capability generation. Only
 * `'composition'` (Profile member or selection edits) produces a new
 * generation for future assemblies; running Sessions stay pinned to the
 * generation they captured at start.
 * @param trigger - the observed change.
 * @returns the refresh kind the trigger belongs to.
 */
export function classifyMcpRefresh(trigger: McpRefreshTrigger): McpRefreshKind {
  return trigger === 'reconnect' || trigger === 'tool-sync' ? 'topology' : 'composition'
}
