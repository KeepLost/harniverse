/** Remote confinement over scripted SSH: passthrough, unavailability mapping, and abort rethrow. */
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { afterEach, describe, expect, it } from 'vitest'
import SshSandboxProvider from '../src/index.ts'

const contexts: Context[] = []

const mount = async (
  script: (method: string, params: unknown, signal?: AbortSignal) => unknown,
): Promise<{ provider: SshSandboxProvider; controller: AbortController }> => {
  const ctx = new Context()
  contexts.push(ctx)
  const controller = new AbortController()
  ctx.provide('ssh', {
    request: async <T>(method: string, params: unknown, schema: { parse: (value: unknown) => T }, signal?: AbortSignal): Promise<T> => {
      const value = await script(method, params, signal)
      if (value instanceof Error) throw value
      return schema.parse(value)
    },
    signal: controller.signal,
  } as never)
  await ctx.plugin(SshSandboxProvider)
  return { provider: (ctx as unknown as { sandbox: SshSandboxProvider }).sandbox, controller }
}

const confined = {
  argv: ['/usr/bin/bwrap', '/bin/sh', '-c', 'true'], enforcement: 'full' as const,
  denialSignatures: ['denied by policy'], runnerFailureRules: [{ fatalSignatures: ['killed'] }],
}
const policy = { mode: 'workspace-write' as const, workspaceRoot: '/machine/work' }

describe('SSH sandbox provider', () => {
  afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

  it('passes machine-resolved confinement through', async () => {
    const { provider } = await mount((method, params) => {
      expect(method).toBe('sandbox')
      expect(params).toMatchObject({ argv: ['/bin/sh', '-c', 'true'], policy })
      return confined
    })
    expect(await provider.confine(['/bin/sh', '-c', 'true'], policy)).toEqual(confined)
  })

  it('fails closed as unavailable when the machine cannot confine', async () => {
    const { provider } = await mount(() => new Error('no runner installed'))
    const failure = await provider.confine(['/bin/sh', '-c', 'true'], policy).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SandboxUnavailableError)
    expect((failure as SandboxUnavailableError).message).toContain('workspace-write')
    expect((failure as SandboxUnavailableError).message).toContain('no runner installed')
  })

  it('wraps non-error failures with their string form', async () => {
    const { provider } = await mount(() => { throw 'plain refusal' })
    const failure = await provider.confine(['/bin/sh', '-c', 'true'], policy).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SandboxUnavailableError)
    expect((failure as SandboxUnavailableError).message).toContain('plain refusal')
  })

  it('rethrows caller cancellation instead of mapping it', async () => {
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    const { provider } = await mount(() => new Error('connection dropped'))
    await expect(provider.confine(['/bin/sh', '-c', 'true'], policy, cancelled.signal)).rejects.toThrow('caller cancelled')
  })
})
