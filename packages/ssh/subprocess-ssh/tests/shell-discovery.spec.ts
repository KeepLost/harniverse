/** Shell lookup failures retain remote execution semantics. */
import { Context } from '@deepseek-ai/cordis'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

it('distinguishes a remote lookup miss from transport failure', async () => {
  const ctx = new Context()
  let failure: Error | undefined
  const request = vi.fn(async <T>(_method: string, _params: unknown, schema: z.ZodType<T>): Promise<T> => {
    if (failure !== undefined) throw failure
    return schema.parse('/remote/bin/bash')
  })
  ctx.provide('ssh', { request } as never)
  const runtime = new SshSubprocessRuntime(ctx)
  const signal = new AbortController().signal
  try {
    expect(await runtime.resolveExecutable('bash', undefined, signal)).toBe('/remote/bin/bash')
    failure = new RemoteOperationError('not an executable file')
    await expect(runtime.resolveExecutable('absent')).rejects.toBe(failure)
    failure = new Error('SSH disconnected')
    await expect(runtime.resolveExecutable('bash')).rejects.toBe(failure)
  } finally { await ctx.fiber.dispose() }
})

it.skipIf(process.platform === 'win32')('queries the real helper and owns its PTY without replacing the shell', async () => {
  const { createHelperHarness } = await import('../../ssh/tests/fixtures/helper.ts')
  const helper = await createHelperHarness()
  const ctx = new Context()
  ctx.provide('ssh', helper.connection as never)
  const runtime = new SshSubprocessRuntime(ctx)
  try {
    await expect(runtime.resolveExecutable(`${helper.root}/absent`)).rejects.toThrow('not an executable file')
    const terminal = await runtime.spawnTerminal({ argv: ['/bin/sh', '-i'], cwd: helper.root, cols: 80, rows: 24, graceMs: 100 })
    let output = ''
    terminal.output.on('data', (chunk: Buffer) => { output += chunk.toString() })
    await terminal.write('printf "REMOTE_SHELL_OK\\n"\n')
    await expect.poll(() => output).toContain('REMOTE_SHELL_OK')
    await terminal.terminate()
    await terminal.done
  } finally {
    try { await ctx.fiber.dispose() } finally { await helper.close() }
  }
})
