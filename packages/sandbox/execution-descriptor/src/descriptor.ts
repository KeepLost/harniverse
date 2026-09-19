/**
 * Parse and verify execution-world descriptors: full shape validation, the
 * machine-owned configuration stance, local-only preset rejection, canonical
 * digest verification, and deep freezing — a parsed descriptor is immutable.
 *
 * @module @deepseek-ai/dsh-execution-descriptor
 */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CapabilityKind } from '@deepseek-ai/dsh-capabilities'
import type { ExecutionWorldDescriptor } from './types.ts'

/**
 * Preset ids whose capabilities are Host-local by design: the `cordis` preset
 * edits the live Cordis composition, which is a Host administration
 * capability, never a remote execution capability. A descriptor naming one
 * of these presets is refused.
 */
export const LOCAL_ONLY_PRESET_IDS: readonly string[] = ['cordis']

/** Capability kinds an execution world may report. */
const ALLOWED_CAPABILITY_KINDS: readonly CapabilityKind[] = ['tool', 'skill', 'mcp-server', 'subagent-provider']

/** Descriptor validation failure. */
export class ExecutionDescriptorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExecutionDescriptorError'
  }
}

/** Valid `worldId`: short, conservative, and collision-hostile. */
const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

/** The digest covers every field except `digest` itself, in canonical JSON. */
export type ExecutionWorldDescriptorInput = Omit<ExecutionWorldDescriptor, 'digest'>

/**
 * Canonical JSON of a descriptor's covered fields: recursively sorted object
 * keys and no insignificant whitespace, so equal content yields equal bytes.
 */
export function canonicalExecutionWorldJson(descriptor: ExecutionWorldDescriptorInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, item]): [string, unknown] => [key, canonical(item)])
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    }
    return value
  }
  return JSON.stringify(canonical(descriptor))
}

/** sha256 hex digest over the canonical form of every covered field. */
export function computeExecutionWorldDigest(descriptor: ExecutionWorldDescriptorInput): string {
  return createHash('sha256').update(canonicalExecutionWorldJson(descriptor)).digest('hex')
}

/** Deep-freeze one parsed descriptor so later mutation fails loudly. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

function fail(message: string): never {
  throw new ExecutionDescriptorError(message)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`execution descriptor field ${field} must be a non-empty string`)
  return value
}

/**
 * Validate and freeze one execution-world descriptor.
 *
 * Refusals: a malformed `worldId`; a transport outside the contract; a
 * `workspaceRoot` that is not an absolute POSIX path; a `configOwner` other
 * than `'machine'`; a capability kind an execution world may not report; a
 * preset id that is Host-local by design (see {@link LOCAL_ONLY_PRESET_IDS});
 * a credential reference that is not a POSIX environment-variable name; and
 * a `digest` that does not match the canonical digest of the covered fields.
 * @param input - the raw descriptor as received from the machine's publisher.
 * @returns the verified, deeply frozen descriptor.
 * @throws {@link ExecutionDescriptorError} on any refusal above.
 */
export function parseExecutionWorldDescriptor(input: unknown): ExecutionWorldDescriptor {
  if (typeof input !== 'object' || input === null) fail('execution descriptor must be an object')
  const raw = input as Record<string, unknown>
  const worldId = readString(raw.worldId, 'worldId')
  if (!WORLD_ID_PATTERN.test(worldId)) fail(`execution descriptor worldId "${worldId}" must match ${WORLD_ID_PATTERN}`)
  const transport = raw.transport
  if (transport !== 'local' && transport !== 'ssh') fail('execution descriptor transport must be "local" or "ssh"')
  const workspaceRoot = readString(raw.workspaceRoot, 'workspaceRoot')
  if (!workspaceRoot.startsWith('/')) fail(`execution descriptor workspaceRoot "${workspaceRoot}" must be an absolute POSIX path inside the execution world`)
  if (raw.configOwner !== 'machine') fail('execution descriptor configOwner must be "machine": the execution machine owns its MCP/Skill/Hook configuration')
  if (!Array.isArray(raw.capabilities)) fail('execution descriptor capabilities must be an array')
  for (const capability of raw.capabilities) {
    const kind = (capability as { kind?: unknown } | null)?.kind
    if (typeof kind !== 'string' || !ALLOWED_CAPABILITY_KINDS.includes(kind as CapabilityKind)) {
      fail(`execution descriptor reports a capability of kind ${JSON.stringify(kind)}; an execution world may report only ${ALLOWED_CAPABILITY_KINDS.join(', ')}`)
    }
  }
  if (!Array.isArray(raw.presets)) fail('execution descriptor presets must be an array')
  for (const preset of raw.presets) {
    if (typeof preset !== 'string') fail('execution descriptor preset ids must be strings')
    if (LOCAL_ONLY_PRESET_IDS.includes(preset)) {
      fail(`execution descriptor names preset "${preset}", which is Host-local by design and never a remote execution capability`)
    }
  }
  if (!Array.isArray(raw.credentialRefs)) fail('execution descriptor credentialRefs must be an array')
  const credentialRefs = raw.credentialRefs.map((ref) => {
    if (typeof ref !== 'string') fail('execution descriptor credentialRefs entries must be strings')
    try {
      return credentialRef(ref)
    } catch (cause) {
      throw new ExecutionDescriptorError(`execution descriptor credentialRef "${ref}" is not a POSIX environment-variable name`, { cause })
    }
  })
  const covered: ExecutionWorldDescriptorInput = {
    worldId,
    transport,
    workspaceRoot,
    capabilities: raw.capabilities as ExecutionWorldDescriptorInput['capabilities'],
    presets: raw.presets as string[],
    configOwner: 'machine',
    credentialRefs,
    revision: readString(raw.revision, 'revision'),
  }
  const digest = readString(raw.digest, 'digest')
  const computed = computeExecutionWorldDigest(covered)
  if (digest !== computed) {
    fail(`execution descriptor digest mismatch: declared ${digest}, computed ${computed}`)
  }
  return deepFreeze({ ...covered, digest })
}

/**
 * Build a descriptor from trusted field values, computing the digest — the
 * publisher-side helper. The result is frozen like a parsed descriptor.
 * @param covered - every covered field; validation runs exactly as in {@link parseExecutionWorldDescriptor}.
 */
export function buildExecutionWorldDescriptor(covered: ExecutionWorldDescriptorInput): ExecutionWorldDescriptor {
  return parseExecutionWorldDescriptor({ ...covered, digest: computeExecutionWorldDigest(covered) })
}
