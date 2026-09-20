/** processJob hook coverage: admission, cancellation and settlement arms — the pwsh twin of dsh-tool-bash's suite. */
/* jscpd:ignore-start -- deliberate twin of dsh-tool-bash/tests/background.spec.ts (Agent Note). */
import { describe, expect, it, vi } from 'vitest'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { processJob } from '../src/background.ts'

function fakeProcess(overrides: Partial<ShellProcess> = {}): ShellProcess {
  const process = {
    status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(), kill: vi.fn(() => true),
  }
  return Object.assign(process, overrides) as ShellProcess
}

describe('processJob hooks', () => {
  it('reads empty output before publication and settles a cancelled start as killed', async () => {
    const deferred = Promise.withResolvers<ShellProcess>()
    const hooks = processJob(() => deferred.promise, proc => `exit ${proc.exitCode}`)
    expect(hooks.readOutput?.()).toBe('')
    hooks.cancel('admission revoked')
    deferred.reject(new Error('admission revoked'))
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'admission revoked' })
  })

  it('reports an uncancelled start failure as failed, stringifying non-Error rejections', async () => {
    // oxlint-disable-next-line prefer-promise-reject-errors -- the hook contract tolerates non-Error rejections
    const rejection = Promise.reject('launcher exploded')
    const hooks = processJob(() => rejection, () => '')
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'launcher exploded' })
  })

  it('kills a process that publishes after cancellation; a second cancel stays inert', async () => {
    const deferred = Promise.withResolvers<ShellProcess>()
    const kill = vi.fn(() => true)
    const hooks = processJob(() => deferred.promise, () => 'rendered')
    hooks.cancel('user kill')
    hooks.cancel('user kill')
    deferred.resolve(fakeProcess({ status: 'killed', exitCode: null, signal: 'SIGTERM', kill }))
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
    expect(kill).toHaveBeenCalledOnce()
  })

  it('renders through the consumer render once the process publishes', async () => {
    const process = fakeProcess()
    const hooks = processJob(async () => process, proc => `exit ${proc.exitCode}`)
    expect(await hooks.done).toEqual({ status: 'completed', detail: 'exit code: 0' })
    expect(hooks.readOutput?.()).toBe('exit 0')
  })
})

/* jscpd:ignore-end */
