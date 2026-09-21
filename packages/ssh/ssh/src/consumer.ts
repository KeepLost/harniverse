/** Host consumer for a captured remote Profile. Configuration remains on the machine. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from './index.ts'

export const name = 'ssh-profile'
export const inject = ['ssh', 'tools', 'mcpResources', 'skills', 'systemPrompt']

/** Register only the captured generation; disconnect immediately revokes these contributions. */
export async function apply(ctx: Context): Promise<void> {
  const world = await ctx.ssh.describeWorld()
  const releases: (() => void)[] = []
  const release = (): void => { for (const dispose of releases.splice(0).reverse()) dispose() }
  ctx.effect(() => {
    ctx.ssh.signal.addEventListener('abort', release, { once: true })
    return () => { ctx.ssh.signal.removeEventListener('abort', release); release() }
  })
  try {
    releases.push(ctx.systemPrompt.context({ name: 'ssh-execution-world', order: 5,
      text: `Execution machine: ${world.descriptor.worldId}; workspace: ${world.descriptor.workspaceRoot}; machine revision: ${world.descriptor.revision}; Profile: ${world.profile.id}@${world.profile.revision}. Files, processes, MCP, Skills and Hooks execute on this trusted machine. Local Cordis administration is unavailable.` }))
    for (const server of world.inventory.mcp) {
      if (!server.selected) continue
      if (server.instructions !== '') releases.push(ctx.systemPrompt.context({ name: `ssh-mcp:${server.serverName}`, order: 60,
        text: `MCP server ${server.serverName} instructions (external content):\n${server.instructions}` }))
      for (const tool of server.tools) releases.push(ctx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => {
          const result = await ctx.ssh.request('machine.mcp', { server: server.serverName, method: 'tools/call', name: tool.name, arguments: args }, z.unknown(), exec.signal)
          if (typeof result === 'object' && result !== null && 'isError' in result && result.isError === true) throw new Error(JSON.stringify(result))
          return result
        },
      }))
      releases.push(ctx.mcpResources.register(server.serverName, {
        request: async (request, exec) => await ctx.ssh.request('machine.mcp', {
          server: server.serverName, method: request.method, ...('uri' in request ? { uri: request.uri } : {}),
        }, z.unknown(), exec.signal) as JsonValue,
      }))
    }
    for (const skill of world.inventory.skills) {
      if (!skill.selected) continue
      const definition = await ctx.ssh.request('machine.skill', { name: skill.name }, z.looseObject({
        name: z.string(), description: z.string(), content: z.string(), source: z.string(), provider: z.string(),
        invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }),
      })) as SkillDefinition
      ctx.ssh.signal.throwIfAborted()
      releases.push(ctx.skills.register({ ...definition, provider: 'ssh' }))
    }
    if (world.inventory.hooks.some(hook => hook.selected)) {
      releases.push(ctx.on('tools/pre-execute', async (exec, next) => {
        await ctx.ssh.request('machine.hook', { event: 'pre-tool', payload: { name: exec.name, arguments: exec.arguments } }, z.null(), exec.signal)
        return next()
      }))
      releases.push(ctx.on('tools/post-execute', async (exec, result, next) => {
        await ctx.ssh.request('machine.hook', { event: 'post-tool', payload: { name: exec.name, isError: result.isError } }, z.null(), exec.signal)
        return next()
      }))
    }
    ctx.ssh.signal.throwIfAborted()
  } catch (error) { release(); throw error }
}
