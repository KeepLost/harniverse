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

/** Whether a candidate server name fits the reserved public namespace budget. */
export function isMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_PATTERN.test(name)
}

/** One resource owned by one MCP server: the server's stable name plus the server-issued resource URI. */
export interface McpResourceIdentity {
  readonly serverName: string
  readonly uri: string
}

/** Type guard for {@link McpResourceIdentity}: valid server name and non-empty URI. */
export function isMcpResourceIdentity(value: unknown): value is McpResourceIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<McpResourceIdentity>
  return typeof candidate.serverName === 'string' && isMcpServerName(candidate.serverName)
    && typeof candidate.uri === 'string' && candidate.uri.length > 0
}

/** Stable capability id of one MCP server, matching the adapter's `mcp-server:<hex>` convention. */
export function mcpServerCapabilityId(serverName: string): string {
  return `mcp-server:${Buffer.from(serverName).toString('hex')}`
}

/** Stable capability member id of one MCP resource, mirroring the `mcp-tool:<hex>` convention. */
export function mcpResourceMemberId(serverName: string, uri: string): string {
  return `${mcpServerCapabilityId(serverName)}/mcp-resource:${Buffer.from(uri).toString('hex')}`
}

/** Members of one server an assembled Agent may reach, narrowed by Profile selection. */
export interface McpMemberVisibility {
  /** The server itself is selected; when false every member is denied. */
  readonly serverSelected: boolean
  /** Tool names visible to the assembled Agent. */
  readonly visibleToolNames: readonly string[]
  /** Resource URIs visible to the assembled Agent. */
  readonly visibleResourceUris: readonly string[]
  /** Tool names the composition must deny. */
  readonly deniedToolNames: readonly string[]
  /** Resource URIs the composition must deny. */
  readonly deniedResourceUris: readonly string[]
}

/**
 * Resolve member visibility for one `mcp-server` catalog entry against the
 * discovered inventory: an unselected server denies every member; a selected
 * server with a member allowlist (`memberEntries`) admits exactly the members
 * marked visible — a narrowed Profile can never reach an excluded server's
 * tools or resources through the shared client. A selected server without an
 * explicit member selection admits everything the server currently reports.
 * @param entry - the resolved catalog entry of one MCP server capability.
 * @param toolNames - every tool name the server currently reports.
 * @param resourceUris - every resource URI the server currently reports.
 */
export function resolveMcpMemberVisibility(
  entry: Pick<CapabilityCatalogEntry, 'selected' | 'memberEntries'>,
  toolNames: readonly string[],
  resourceUris: readonly string[],
): McpMemberVisibility {
  if (!entry.selected) {
    return {
      serverSelected: false,
      visibleToolNames: [],
      visibleResourceUris: [],
      deniedToolNames: [...toolNames],
      deniedResourceUris: [...resourceUris],
    }
  }
  const members = entry.memberEntries
  if (members === undefined) {
    return {
      serverSelected: true,
      visibleToolNames: [...toolNames],
      visibleResourceUris: [...resourceUris],
      deniedToolNames: [],
      deniedResourceUris: [],
    }
  }
  const visibleTools: string[] = []
  const visibleResources: string[] = []
  for (const member of members) {
    if (!member.visible) continue
    if (member.kind === 'mcp-tool' && toolNames.includes(member.name)) visibleTools.push(member.name)
    if (member.kind === 'mcp-resource' && resourceUris.includes(member.name)) visibleResources.push(member.name)
  }
  return {
    serverSelected: true,
    visibleToolNames: visibleTools,
    visibleResourceUris: visibleResources,
    deniedToolNames: toolNames.filter(name => !visibleTools.includes(name)),
    deniedResourceUris: resourceUris.filter(uri => !visibleResources.includes(uri)),
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
 */
export function classifyMcpRefresh(trigger: McpRefreshTrigger): McpRefreshKind {
  return trigger === 'reconnect' || trigger === 'tool-sync' ? 'topology' : 'composition'
}
