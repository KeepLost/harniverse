import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@fixture/domain'
import type {
  CreateGoalRequest,
  CreateGoalResult,
  RenameGoalRequest,
  RenameGoalResult,
} from './types.ts'

/** Remote-only business Service with no Cordis declaration merge. */
export class GoalService extends TypertRemoteService {
  constructor() {
    super(undefined, 'goals')
  }

  @Remote({ requiredCapability: 'harniverse.operate' })
  async create(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): Promise<CreateGoalResult> {
    signal.throwIfAborted()
    return { ref: `${agent.id}:${request.title}` }
  }

  @RemoteScope('agent', { requiredCapability: 'harniverse.operate' })
  rename(request: RenameGoalRequest): RenameGoalResult {
    return { renamed: request.title.length > 0 }
  }
}

export type {
  CreateGoalRequest,
  CreateGoalResult,
  RenameGoalRequest,
  RenameGoalResult,
} from './types.ts'
