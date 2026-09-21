import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RemoteOperationError, SshRpcPeer } from '../src/protocol.ts'

describe('SSH shared control transport', () => {
  it('validates replies and preserves remote error codes', async () => {
    const left = new PassThrough()
    const right = new PassThrough()
    const client = new SshRpcPeer(right, left)
    const server = new SshRpcPeer(left, right, undefined, undefined, async (method) => {
      if (method === 'fail') throw Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' })
      return { result: 42 }
    })
    try {
      expect(await client.request('read', {}, z.object({ result: z.number() }))).toEqual({ result: 42 })
      await expect(client.request('fail', {}, z.unknown())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(client.request('fail', {}, z.unknown())).rejects.toBeInstanceOf(RemoteOperationError)
    } finally { await Promise.all([client.dispose(), server.dispose()]) }
  })

  it('cancellation revokes pending handlers and refuses replay', async () => {
    const left = new PassThrough()
    const right = new PassThrough()
    // Annotated binding (not withResolvers<void>()): the tests lint layer runs
    // no-invalid-void-type with default options, which rejects the explicit
    // type argument in call position but accepts the inferred form.
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    let aborted = false
    const client = new SshRpcPeer(right, left)
    const server = new SshRpcPeer(left, right, undefined, undefined, async (_method, _params, signal) => {
      started.resolve()
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
      return null
    })
    const controller = new AbortController()
    const request = client.request('wait', {}, z.null(), controller.signal)
    const rejected = expect(request).rejects.toThrow('cancelled')
    await started.promise
    controller.abort()
    await rejected
    await Promise.all([client.dispose(), server.dispose()])
    expect(aborted).toBe(true)
    await expect(client.request('retry', {}, z.null())).rejects.toThrow('cancelled')
  })
})
