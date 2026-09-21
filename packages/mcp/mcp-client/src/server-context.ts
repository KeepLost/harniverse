/**
 * Publish connection-owned MCP resources and literal server instructions.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import { MCP_SECTION_ORDER } from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Connection-owned values used by the resource and prompt consumers. */
export interface ServerContext {
  /** Resource access through the current connection generation. */
  resources: McpResourceProvider
  /**
   * Read the last successfully connected server's attributed instructions.
   * @returns literal prompt text, or an empty string when no server instructions are active.
   */
  instructions(): string
}

/**
 * Contribute server context to the services enabled by this composition.
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured public server identity used for resource routing.
 * @param owner - reservation identity; distinct owners of one public name keep
 * distinct instruction sections instead of colliding in the same scope layer.
 * @param connection - live resource operations and successful instruction snapshot.
 * @param visible - authorization for the caller's scope key, not its Context.
 */
export function registerServerContext(
  ctx: Context,
  server: string,
  owner: string,
  connection: ServerContext,
  visible: (scope: object | undefined) => boolean = () => true,
): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources, { visible })
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${owner}`,
      order: MCP_SECTION_ORDER,
      interpolate: false,
      text: ({ scope }) => visible(scope) ? connection.instructions() : '',
    })
  })
}
