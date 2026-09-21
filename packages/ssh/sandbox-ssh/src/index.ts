/** Remote confinement delegates runner selection and canonicalization to the execution machine. */
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-ssh'
import { z } from 'zod'

export class SshSandboxProvider extends SandboxProvider {
  static inject = ['ssh']
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    try {
      return await this.ctx.ssh.request('sandbox', { argv, policy }, z.object({
        argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()),
        runnerFailureRules: z.array(z.object({
          allowedExitCodes: z.array(z.number()).optional(), fatalSignatures: z.array(z.string()),
          informationalLines: z.array(z.string()).optional(),
        }).strict()),
      }).strict(), signal) as ConfinedArgv
    } catch (error) {
      signal?.throwIfAborted()
      throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : String(error))
    }
  }
}
export default SshSandboxProvider
