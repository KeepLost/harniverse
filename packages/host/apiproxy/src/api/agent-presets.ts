/** Agent Profile roster and authoring wire contract. */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One server-defined Agent Profile offered when creating a Session. */
export interface AgentPresetEntry {
  /** Stable identifier, also the display-name fallback. */
  readonly id: string
  /** Whether the Profile ships with the deployment or was authored locally. */
  readonly trust: 'system' | 'user'
  /** Whether an unnamed Session gets this Profile. */
  readonly isDefault: boolean
  /** Published display name. */
  readonly name?: string
  /** Published one-sentence description. */
  readonly description?: string
  /** Permission preset applied before this Profile's Agent is published. */
  readonly permissionPreset?: string
  /** Why this Profile cannot compose a Session. */
  readonly broken?: string
}

/** Agent Profile roster and privileged authoring methods. */
export interface AgentPresetsApi {
  /** List every Profile in root-precedence order and deployment authoring capabilities. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{
    presets: readonly AgentPresetEntry[]
    authorable: boolean
    hasDocument: boolean
  }>>

  /** Read one Profile's composition text for the read-only viewer. */
  read(request: RpcRequest<{ agentPreset: string }>): Promise<RpcResponse<{
    agentPreset: string
    trust: 'system' | 'user'
    content: string
    name?: string
    description?: string
  }>>

  /** Create a locally authored Profile by copying an existing Profile whole. */
  copy(request: RpcRequest<{ from: string; agentPreset: string; name?: string }>):
  Promise<RpcResponse<{ agentPreset: string }>>

  /** Open one locally authored Profile directory, or return its path when no opener exists. */
  openDocument(request: RpcRequest<{ agentPreset: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true } | { opened: false; path: string }>>

  /** Delete a locally authored Profile. */
  remove(request: RpcRequest<{ agentPreset: string }>): Promise<RpcResponse<{}>>
}
