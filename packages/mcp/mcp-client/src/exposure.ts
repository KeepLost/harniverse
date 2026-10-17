/**
 * Scoped exposure of one MCP server: server context (resources + attributed
 * instructions), capability adapter with per-composition member restriction,
 * and the resource-visibility bookkeeping both exposure routes share. The
 * standalone plugin and the shared-connection registrar call the same
 * function, so a profile composition sees one contract either way.
 *
 * @module
 */

import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-capabilities'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import {
  mcpResourceMemberId,
  mcpResourceTemplateMemberId,
  resolveMcpMemberVisibility,
} from './resource-contract.ts'
import type { McpMemberVisibility } from './resource-contract.ts'
import { registerServerContext } from './server-context.ts'

/** Inventory face every exposure route reads from its live connection. */
export interface ScopedServerInventory {
  /** Public tool names in the current last-good generation. */
  toolNames(): string[]
  /** Whether a live generation completed its initial synchronization. */
  connected(): boolean
  /** Sorted resource URIs from the last successful inventory. */
  resourceUris(): string[]
  /** Sorted URI templates from the same inventory. */
  resourceTemplates(): string[]
  /** Attributed server instructions, or an empty string while down. */
  instructions(): string
  /** Resource operations through the current connection generation. */
  resources: McpResourceProvider
}

/**
 * Install one server's scoped exposure on this context.
 *
 * @param ctx - the owning plugin's context (effect parent for every seat).
 * @param serverName - public server namespace used in model-facing names.
 * @param reservationKey - optional per-scope reservation owner key.
 * @param inventory - live inventory view of the connection being exposed.
 * @returns the invalidation hook to call whenever the inventory may have
 *   changed; it re-fires the capability adapter and every composition's
 *   member restriction.
 */
export function exposeScopedServer(
  ctx: Context,
  serverName: string,
  reservationKey: string | undefined,
  inventory: ScopedServerInventory,
): () => void {
  let capabilityChanged = (): void => {}
  const restrictionRefreshers = new Set<() => void>()
  /**
   * Resource URIs visible per composition scope key. A Profile member
   * selection records its narrowing here; a scope with no record (including
   * compositions without the capabilities service) reaches every resource.
   */
  const resourceSelection = new WeakMap<object, McpMemberVisibility>()

  /** Nearest composition record on the caller's scope chain, or undefined when unrestricted. */
  const nearestResourceRecord = (agent: object | undefined): McpMemberVisibility | undefined => {
    for (const key of scopeChainOf(agent)) {
      const record = resourceSelection.get(key)
      if (record !== undefined) return record
    }
    return undefined
  }

  /**
   * Narrow one resources/list result to the caller-visible URIs; other result
   * shapes pass through untouched.
   */
  const filterResourceList = (result: JsonValue, visible: McpMemberVisibility, templates: boolean): JsonValue => {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
    const key = templates ? 'resourceTemplates' : 'resources'
    const resources = (result as Record<string, unknown>)[key]
    if (!Array.isArray(resources)) return result
    const kept = resources.filter((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
      const value = templates ? (item as { uriTemplate?: unknown }).uriTemplate : (item as { uri?: unknown }).uri
      return typeof value === 'string' && (templates ? visible.visibleResourceTemplates.includes(value) : visible.visibleResourceUris.includes(value))
    })
    return { ...result, [key]: kept }
  }

  const templateMatches = (template: string, uri: string): boolean => new UriTemplate(template).match(uri) !== null

  // Resource requests are enforced at the provider — the composition that
  // made the decision cannot be bypassed by calling the shared tools with a
  // different server argument.
  registerServerContext(ctx, serverName, reservationKey ?? serverName, {
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const record = nearestResourceRecord(exec.agent)
        if (record !== undefined && !record.serverSelected) {
          throw new Error(`mcp-client(${serverName}): resource server is not visible to this agent`)
        }
        if (request.method === 'resources/read' && record !== undefined && !record.unrestrictedResources
          && !record.visibleResourceUris.includes(request.uri)
          && !record.visibleResourceTemplates.some(template => templateMatches(template, request.uri))) {
          throw new Error(`mcp-client(${serverName}): resource "${request.uri}" is not visible to this agent`)
        }
        const result = await inventory.resources.request(request, exec)
        if (record === undefined || record.unrestrictedResources) return result
        if (request.method === 'resources/list') return filterResourceList(result, record, false)
        if (request.method === 'resources/templates/list') return filterResourceList(result, record, true)
        return result
      },
    },
    instructions: () => inventory.instructions(),
  }, scope => nearestResourceRecord(scope)?.serverSelected !== false)

  ctx.inject(['capabilities'], (capabilityCtx) => {
    const encodedName = Buffer.from(serverName).toString('hex')
    const capabilityId = `mcp-server:${encodedName}`
    capabilityCtx.capabilities.registerAdapter((control) => {
      capabilityChanged = () => { control.invalidate() }
      return {
        id: `mcp-client:${encodedName}`,
        snapshot: () => ({
          complete: true,
          entries: [{
            id: capabilityId,
            kind: 'mcp-server',
            name: serverName,
            description: `MCP server ${serverName}`,
            provenance: 'external',
            assembleable: true,
            available: inventory.connected(),
            defaultLoaded: true,
            manageable: true,
            owner: '@deepseek-ai/dsh-mcp-client',
            requires: [],
            members: [
              ...inventory.toolNames().map(name => ({
                id: `${capabilityId}/mcp-tool:${Buffer.from(name).toString('hex')}`,
                kind: 'mcp-tool' as const,
                name,
                description: `MCP tool ${name}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
              ...inventory.resourceUris().map(uri => ({
                id: mcpResourceMemberId(serverName, uri),
                kind: 'mcp-resource' as const,
                name: uri,
                description: `MCP resource ${uri}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
              ...inventory.resourceTemplates().map(uriTemplate => ({
                id: mcpResourceTemplateMemberId(serverName, uriTemplate),
                kind: 'mcp-resource' as const,
                name: uriTemplate,
                description: `MCP resource template ${uriTemplate}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
            ],
          }],
        }),
        restrict: (compositionCtx, entries) => {
          const entry = entries.find(candidate => candidate.id === capabilityId)
          if (entry === undefined) return
          const tools = compositionCtx.get('tools')
          if (tools === undefined) return
          const scope = scopeOf(compositionCtx)
          let release = (): void => {}
          const refresh = (): void => {
            const names = inventory.toolNames()
            const uris = inventory.resourceUris()
            const templates = inventory.resourceTemplates()
            const visibility = resolveMcpMemberVisibility(entry, names, uris, templates)
            if (scope !== undefined) resourceSelection.set(scope, visibility)
            const denied = visibility.serverSelected ? visibility.deniedToolNames : names
            const next = denied.length === 0
              ? (): void => {}
              : tools.restrict({ deny: denied, includeOwn: true })
            const previous = release
            release = next
            previous()
          }
          compositionCtx.effect(() => {
            restrictionRefreshers.add(refresh)
            refresh()
            return () => {
              restrictionRefreshers.delete(refresh)
              if (scope !== undefined) resourceSelection.delete(scope)
              release()
            }
          }, `mcp-client.capabilityComposition(${JSON.stringify(serverName)})`)
        },
      }
    })
    capabilityCtx.effect(() => () => { capabilityChanged = () => {} }, 'mcp-client.capabilities()')
  })

  return () => {
    capabilityChanged()
    for (const refresh of restrictionRefreshers) {
      try {
        refresh()
      } catch (error) {
        ctx.logger.error(`mcp-client(${serverName}): composition restriction refresh failed: ${String(error)}`)
      }
    }
  }
}
