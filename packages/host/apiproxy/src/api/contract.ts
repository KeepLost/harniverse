/** Browser-safe discovery contract for the stable unary API surface. */

import type { AuthenticationCapability } from '@deepseek-ai/dsh-authentication'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Lifecycle label for one public API method. */
export type RpcMethodStability = 'stable' | 'deprecated'

/** Metadata a client needs before invoking one public method. */
export interface ApiMethodDescription {
  method: string
  requiredCapability: AuthenticationCapability
  effect: 'read' | 'mutate'
  stability: RpcMethodStability
  replacement?: string
}

/** Versioned description of the public API registry. */
export interface ApiContractDescription {
  version: 1
  methods: ApiMethodDescription[]
}

/** Contract discovery methods. */
export interface ApiApi {
  describe(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<ApiContractDescription>>
}
