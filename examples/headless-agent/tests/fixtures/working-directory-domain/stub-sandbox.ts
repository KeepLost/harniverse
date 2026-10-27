/** Test-only identity sandbox: confines by returning the caller's argv unchanged. */

import { Service } from '@deepseek-ai/cordis'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

export const name = 'stub-sandbox'

/** Deterministic confinement for hosts without a usable kernel-sandbox backend. */
export class StubSandbox extends Service implements SandboxProvider {
  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx, 'sandbox')
  }

  get sandboxMode(): undefined {
    return undefined
  }

  async confine(argv: readonly string[]): Promise<{ argv: string[]; enforcement: 'full'; denialSignatures: readonly string[]; runnerFailureRules: readonly [] }> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

export default StubSandbox
