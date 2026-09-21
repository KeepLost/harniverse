/** Immutable execution inventory and captured Host Profile permission contract. */
import { createHash } from 'node:crypto'
import { buildExecutionWorldDescriptor, parseExecutionWorldDescriptor } from '@deepseek-ai/dsh-execution-descriptor'
import type { ExecutionWorldDescriptor } from '@deepseek-ai/dsh-execution-descriptor'
import type { CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'
import { z } from 'zod'

/** Explicit captured selections: omitted servers, Skills and Hooks are denied. */
export const capturedProfileSchema = z.object({
  id: z.string().min(1).refine(value => value !== 'cordis', 'cordis is Host-local'),
  revision: z.string().min(1),
  mcp: z.record(z.string(), z.object({ members: z.array(z.string()).optional() }).strict()),
  skills: z.array(z.string()),
  hooks: z.array(z.string()),
}).strict()
export type CapturedRemoteProfile = z.infer<typeof capturedProfileSchema>

/** No remote command, header, credential value, or local Host path is in this wire shape. */
export const machineInventorySchema = z.object({
  mcp: z.array(z.object({
    serverName: z.string(), selected: z.boolean(), instructions: z.string(),
    tools: z.array(z.object({
      name: z.string(), rawName: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()),
    }).strict()),
    resources: z.array(z.looseObject({ uri: z.string(), name: z.string() })),
    templates: z.array(z.looseObject({ uriTemplate: z.string(), name: z.string() })),
  }).strict()),
  skills: z.array(z.object({ name: z.string(), description: z.string(), path: z.string(), selected: z.boolean() }).strict()),
  hooks: z.array(z.object({ id: z.string(), event: z.enum(['pre-tool', 'post-tool']), selected: z.boolean() }).strict()),
}).strict()
export type MachineInventory = z.infer<typeof machineInventorySchema>
export interface WorldDescription {
  readonly descriptor: ExecutionWorldDescriptor
  readonly profile: CapturedRemoteProfile
  readonly inventory: MachineInventory
}

/** Build the machine descriptor from actual discovery, separate from the Host Profile revision. */
export function describeExecutionWorld(
  workspaceRoot: string, revision: string, profile: CapturedRemoteProfile, inventory: MachineInventory,
): WorldDescription {
  const capabilities: CapabilityDescriptor[] = ['filesystem', 'subprocess', 'sandbox'].map(name => ({
    id: `remote-${name}`, kind: 'tool', name, description: `Remote ${name} provider`, provenance: 'harniverse-adapted',
    available: true, assembleable: true, defaultLoaded: true, manageable: false, requires: [],
  }))
  for (const server of inventory.mcp) capabilities.push({
    id: `mcp-server:${Buffer.from(server.serverName).toString('hex')}`, kind: 'mcp-server', name: server.serverName,
    description: 'Machine-owned MCP server', provenance: 'external', available: server.selected,
    assembleable: true, defaultLoaded: server.selected, manageable: false, requires: [],
  })
  for (const skill of inventory.skills) capabilities.push({
    id: `remote-skill:${skill.name}`, kind: 'skill', name: skill.name, description: skill.description,
    provenance: 'external', available: true, assembleable: true, defaultLoaded: skill.selected, manageable: false, requires: [],
  })
  return parseWorldDescription({
    descriptor: buildExecutionWorldDescriptor({
      worldId: `ssh-${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`,
      transport: 'ssh', workspaceRoot, revision, configOwner: 'machine', credentialRefs: [], presets: ['ssh'], capabilities,
    }), profile, inventory,
  })
}

/** Verify the descriptor digest and detach every permission/inventory value from its input. */
export function parseWorldDescription(input: unknown): WorldDescription {
  const parsed = z.object({
    descriptor: z.unknown(), profile: capturedProfileSchema, inventory: machineInventorySchema,
  }).strict().parse(input)
  const result = { ...parsed, descriptor: parseExecutionWorldDescriptor(parsed.descriptor) }
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(result)
  return result
}
