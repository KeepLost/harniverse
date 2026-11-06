/**
 * Loader-fixture agents stand-in: one scripted live initiator whose
 * identity satisfies the real user-questions liveness boundary (`get`
 * returns the exact instance, `roots` includes it), so the composition
 * tier exercises the genuine ask() gate rather than bypassing it.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Stub agents service: exactly one live root initiator. */
export default class StubAgents extends Service {
  readonly root: Agent

  constructor(ctx: Context) {
    super(ctx, 'agents')
    this.root = { id: 'stub-initiator' } as Agent
  }

  currentInitiator(): Agent | undefined {
    return this.root
  }

  get(id: string): Agent | undefined {
    return id === this.root.id ? this.root : undefined
  }

  roots(): Agent[] {
    return [this.root]
  }
}
