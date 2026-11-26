/**
 * Agent profiles: the per-agent behavior layered on top of the protocol. A
 * profile is data plus at most one request rewrite, and the protocol path
 * consults one only when the agent definition pins it or the agent's reported
 * name matches.
 * @module @deepseek-ai/dsh-acp-client/profile
 */

import { AcpError } from './errors.ts'
import type { AcpAgentProfile } from './types.ts'

/** What selects a profile for one agent. */
export interface AcpProfileSelection {
  /** Profiles the consumer supplied, in its order. */
  readonly profiles: readonly AcpAgentProfile[] | undefined
  /** Id the agent definition pinned, when it pinned one. */
  readonly pinned: string | undefined
  /** Name the agent reported at the handshake; absent before it. */
  readonly agentName: string | undefined
}

/**
 * Select the profile that applies to one agent. A pinned id wins and must
 * name a supplied profile; otherwise the first supplied profile whose
 * `agents` lists the reported name applies.
 * @param selection - the supplied profiles, the pinned id, and the reported name.
 * @returns the applicable profile, or `undefined` when none applies.
 * @throws an `AcpError` of kind `unsupported` when the pinned id names no profile.
 */
export function selectProfile(selection: AcpProfileSelection): AcpAgentProfile | undefined {
  const profiles = selection.profiles ?? []
  if (selection.pinned !== undefined) {
    const pinned = profiles.find(profile => profile.id === selection.pinned)
    if (pinned === undefined) {
      throw new AcpError('unsupported', `no ACP agent profile is registered as "${selection.pinned}"`)
    }
    return pinned
  }
  const name = selection.agentName
  if (name === undefined) return undefined
  return profiles.find(profile => profile.agents?.includes(name) === true)
}
