/** Browser-safe operation lookup contract for accepted asynchronous work. */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Public state of an accepted operation. */
export type OperationStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Point-in-time operation view; result data remains on the owning domain. */
export interface OperationView {
  operationId: string
  kind: 'session.prompt' | 'subagent.prompt' | 'job'
  status: OperationStatus
  acceptedAt: number
  finishedAt?: number
  sessionId?: SessionId
  messageId?: MessageId
  jobId?: JobId
}

/** Operation query methods. */
export interface OperationsApi {
  get(request: RpcRequest<{ operationId: string; sessionId?: SessionId }>): Promise<RpcResponse<OperationView>>
}
