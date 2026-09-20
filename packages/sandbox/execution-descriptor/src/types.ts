/**
 * Types for the immutable execution-world descriptor: the contract a remote
 * execution machine publishes before an Agent Profile may target it. Types
 * only — no runtime code.
 *
 * @module @deepseek-ai/dsh-execution-descriptor
 */

import type { CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** How the execution world is reached. */
export type ExecutionTransport = 'local' | 'ssh'

/**
 * One execution world's immutable self-description.
 *
 * The machine that executes owns the configuration that governs execution
 * (`configOwner` is fixed at `'machine'`): MCP servers, skills, and hooks run
 * under this machine's configuration, and discovery results return to the
 * host as this descriptor's capability inventory. The host keeps the agent
 * core, model connection, session authority, and the transport connection.
 */
export interface ExecutionWorldDescriptor {
  /** Stable identity of the execution world within one deployment. */
  readonly worldId: string
  /** Transport this world is reached over; SSH worlds are POSIX-scoped. */
  readonly transport: ExecutionTransport
  /**
   * Absolute POSIX path of the workspace root inside the execution world.
   * A host-local path is never serialized: this path belongs to the
   * execution machine's own filesystem.
   */
  readonly workspaceRoot: string
  /** Capability inventory this machine truthfully reports for assembly. */
  readonly capabilities: readonly CapabilityDescriptor[]
  /** Remote-execution presets this world supports; local-only presets are excluded by parsing. */
  readonly presets: readonly string[]
  /** Fixed: the execution machine owns MCP/Skill/Hook configuration. */
  readonly configOwner: 'machine'
  /** Credential references by environment-variable name; values never travel. */
  readonly credentialRefs: readonly CredentialRef[]
  /** Monotonic revision of this world's state, owned by the execution machine. */
  readonly revision: string
  /** sha256 over the canonical JSON of every field above; verified at parse. */
  readonly digest: string
}
