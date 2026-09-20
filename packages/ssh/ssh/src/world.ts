/**
 * Machine-owned execution-world inventory: the SSH helper describes the
 * machine it runs on as a digest-verified {@link ExecutionWorldDescriptor}
 * plus a hook report, and the host restricts that inventory against the
 * Agent Profile's pinned capability selections — never rewriting machine
 * configuration, only choosing what it assembles.
 *
 * @module @deepseek-ai/dsh-ssh/world
 */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  buildExecutionWorldDescriptor,
  parseExecutionWorldDescriptor,
} from '@deepseek-ai/dsh-execution-descriptor'
import type { ExecutionWorldDescriptor } from '@deepseek-ai/dsh-execution-descriptor'
import type { CapabilityDescriptor, CapabilityOverride } from '@deepseek-ai/dsh-capabilities'
import { z } from 'zod'

/** One machine-configured MCP server as the world truthfully reports it: identity only, never secrets. */
export interface MachineMcpServerRow {
  /** Stable key the machine reconciles this entry by. */
  readonly id: string
  /** Stable namespace used in model-facing tool names. */
  readonly serverName: string
  /** MCP transport the machine selected for this entry. */
  readonly transport: 'stdio' | 'streamable-http'
  /** Disabled entries are reported but not assembled by default. */
  readonly enabled: boolean
  /** Environment-variable NAMES the machine's entry references; values never travel. */
  readonly envKeys: readonly string[]
}

/** One machine-local Skill as the world reports it. */
export interface MachineSkillRow {
  /** Stable Skill identity on this machine. */
  readonly id: string
  /** Model-facing Skill name. */
  readonly name: string
  /** Machine-local discovery source that produced this row. */
  readonly source: string
}

/** One machine-local Hook family listing; hooks are machine-owned configuration, not a capability kind. */
export interface MachineHookRow {
  /** Hook family whose machine-local configuration this row reports. */
  readonly family: 'claude-code' | 'codex'
  /** Machine-local path or scope the family was discovered in. */
  readonly source: string
  /** Number of configured hooks in that family. */
  readonly hooks: number
}

/** The machine-owned configuration snapshot a world description is built from. */
export interface MachineConfigSnapshot {
  readonly mcpServers: readonly MachineMcpServerRow[]
  readonly skills: readonly MachineSkillRow[]
  readonly hooks: readonly MachineHookRow[]
}

/** Provider presence the helper itself mounted; each mounted service backs one truthful tool row. */
export interface HelperProviderTruth {
  readonly filesystem: boolean
  readonly subprocess: boolean
  readonly sandbox: boolean
}

/**
 * Machine-side inventory source a remote composition implements to report
 * its machine-local MCP/Skill/Hook configuration. The default helper reports
 * an empty snapshot — truthfully, because it mounts no user configuration.
 */
export interface MachineInventoryProvider {
  snapshot(): Promise<MachineConfigSnapshot>
}

/** The truthful empty inventory reported when no machine composition supplied one. */
export const EMPTY_MACHINE_INVENTORY: MachineConfigSnapshot = { mcpServers: [], skills: [], hooks: [] }

/** Everything a world description needs; every field is machine-owned. */
export interface DescribeWorldInput {
  /** Stable identity of the execution world within one deployment. */
  readonly worldId: string
  /** Absolute POSIX workspace root inside the execution world. */
  readonly workspaceRoot: string
  /** Monotonic revision of the machine's state. */
  readonly revision: string
  /** Remote-execution presets this machine supports; local-only presets are refused by the descriptor. */
  readonly presets?: readonly string[]
  /** Helper-mounted provider presence backing the tool rows. */
  readonly providers?: HelperProviderTruth
  /** Machine-owned configuration inventory. */
  readonly inventory?: MachineConfigSnapshot
}

/** A described world: the digest-verified descriptor plus the hook report hooks cannot fit inside. */
export interface WorldDescription {
  readonly descriptor: ExecutionWorldDescriptor
  readonly hooks: readonly MachineHookRow[]
}

const TOOL_ROW_IDS: readonly (readonly [keyof HelperProviderTruth, string, string, string])[] = [
  ['filesystem', 'remote-fs', 'Remote filesystem', 'Filesystem effects through the SSH helper mounted local filesystem providers'],
  ['subprocess', 'remote-subprocess', 'Remote subprocess', 'Process effects through the SSH helper mounted local subprocess runtime'],
  ['sandbox', 'remote-sandbox', 'Remote sandbox', 'Confinement wrapping through the SSH helper mounted local sandbox provider'],
]

/**
 * Derive a stable descriptor-valid world identity from the machine's host
 * name and workspace root.
 * @param hostname - the execution machine's host name.
 * @param workspaceRoot - the machine's absolute workspace root.
 * @returns a `worldId` matching the descriptor contract pattern.
 */
export function deriveWorldId(hostname: string, workspaceRoot: string): string {
  const host = hostname.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replaceAll(/-{2,}/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 24)
  const workspace = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
  const candidate = `${host === '' ? 'ssh' : host}-${workspace}`
  // v8 ignore next 1 -- defensive floor: every candidate exceeds the pattern minimum by construction
  return candidate.length < 3 ? `w-${workspace}` : candidate
}

/**
 * Describe one execution world from machine-owned inputs, computing and
 * verifying the descriptor digest.
 * @param input - machine-owned identity, workspace, revision and inventory.
 * @returns the digest-verified descriptor and the hook report beside it.
 */
export function describeExecutionWorld(input: DescribeWorldInput): WorldDescription {
  const providers = input.providers ?? { filesystem: true, subprocess: true, sandbox: true }
  const inventory = input.inventory ?? EMPTY_MACHINE_INVENTORY
  const capabilities: CapabilityDescriptor[] = []
  for (const [mounted, id, name, description] of TOOL_ROW_IDS) {
    if (!providers[mounted]) continue
    capabilities.push({
      id, kind: 'tool', name, description, provenance: 'harniverse-adapted',
      assembleable: true, available: true, defaultLoaded: true, manageable: false, requires: [],
    })
  }
  for (const server of inventory.mcpServers) {
    capabilities.push({
      id: server.id, kind: 'mcp-server', name: server.serverName,
      description: `Machine-configured MCP server over ${server.transport}`,
      provenance: 'external',
      assembleable: false, available: server.enabled, defaultLoaded: server.enabled,
      manageable: false, requires: [],
    })
  }
  for (const skill of inventory.skills) {
    capabilities.push({
      id: skill.id, kind: 'skill', name: skill.name,
      description: `Machine-local skill from ${skill.source}`,
      provenance: 'external',
      assembleable: false, available: true, defaultLoaded: true, manageable: false, requires: [],
    })
  }
  const credentialRefs = [...new Set(inventory.mcpServers.flatMap(server => server.envKeys))].map(credentialRef)
  const descriptor = buildExecutionWorldDescriptor({
    worldId: input.worldId,
    transport: 'ssh',
    workspaceRoot: input.workspaceRoot,
    capabilities,
    presets: input.presets ?? [],
    configOwner: 'machine',
    credentialRefs,
    revision: input.revision,
  })
  return { descriptor, hooks: inventory.hooks }
}

/** Why one machine-reported capability is not part of the Profile-effective assembly. */
export type WorldRestrictionReason = 'unloaded-by-profile' | 'members-excluded'

/** One machine-reported capability the Profile excluded. */
export interface WorldRestrictionEntry {
  readonly id: string
  readonly reason: WorldRestrictionReason
}

/** A world inventory restricted by one Agent Profile's pinned selections. */
export interface RestrictedWorld {
  /** Machine-reported capabilities the Profile permits assembling, member-filtered. */
  readonly effective: readonly CapabilityDescriptor[]
  /** Machine-reported capabilities the Profile excludes, with the reason. */
  readonly excluded: readonly WorldRestrictionEntry[]
  /** Profile selections naming capabilities this world does not report. */
  readonly unresolved: readonly string[]
}

/**
 * Restrict a described world's inventory against an Agent Profile's pinned
 * capability overrides. The host never rewrites machine configuration: it
 * only decides what it assembles from the truthful inventory.
 * @param world - the digest-verified machine descriptor.
 * @param profile - the Profile's capability overrides keyed by capability id.
 * @returns the effective, excluded and unresolved splits.
 */
export function restrictWorldToProfile(
  world: ExecutionWorldDescriptor,
  profile: Readonly<Record<string, CapabilityOverride>>,
): RestrictedWorld {
  const effective: CapabilityDescriptor[] = []
  const excluded: WorldRestrictionEntry[] = []
  const unresolved: string[] = []
  for (const [id] of Object.entries(profile)) {
    if (!world.capabilities.some(capability => capability.id === id)) unresolved.push(id)
  }
  for (const capability of world.capabilities) {
    const override = profile[capability.id]
    if (override?.selection === 'unload') {
      excluded.push({ id: capability.id, reason: 'unloaded-by-profile' })
      continue
    }
    const allowed = override?.members
    if (allowed !== undefined) {
      const members = capability.members?.filter(member => allowed.includes(member.id)) ?? []
      if (members.length === 0) {
        excluded.push({ id: capability.id, reason: 'members-excluded' })
        continue
      }
      effective.push({ ...capability, members })
      continue
    }
    effective.push(capability)
  }
  return { effective, excluded, unresolved }
}

/** One machine hook listing as it crosses the world description response. */
export const machineHookRowSchema = z.object({
  family: z.enum(['claude-code', 'codex']),
  source: z.string(),
  hooks: z.number().int().nonnegative(),
}).strict()

/** The world description response: the descriptor travels unparsed for digest verification, hooks validate here. */
export const worldDescribeResponseSchema = z.object({
  descriptor: z.unknown(),
  hooks: z.array(machineHookRowSchema),
}).strict()

/**
 * Parse and verify a world description response: hook rows validate by
 * schema and the descriptor by its own digest-checking parser.
 * @param response - the raw `world.describe` response payload.
 * @returns the verified world description.
 */
export function parseWorldDescription(response: unknown): WorldDescription {
  const parsed = worldDescribeResponseSchema.parse(response)
  return { descriptor: parseExecutionWorldDescriptor(parsed.descriptor), hooks: parsed.hooks }
}
