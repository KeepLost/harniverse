/** Bounded RPC over the shared control channel: reply validation, limits, and closure propagation. */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { encodeControlFrame } from '@deepseek-ai/dsh-control-channel'
import { RemoteOperationError, SshRpcPeer } from '../src/protocol.ts'

describe('SSH shared control transport', () => {
  it('validates replies and preserves remote error codes', async () => {
    const left = new PassThrough()
    const right = new PassThrough()
    const client = new SshRpcPeer(right, left)
    const server = new SshRpcPeer(left, right, undefined, undefined, async (method) => {
      if (method === 'fail') throw Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' })
      if (method === 'plain') throw new Error('denied without code')
      if (method === 'non-error') throw 'plain string rejection'
      return { result: 42 }
    })
    try {
      expect(await client.request('read', {}, z.object({ result: z.number() }))).toEqual({ result: 42 })
      await expect(client.request('fail', {}, z.unknown())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(client.request('fail', {}, z.unknown())).rejects.toBeInstanceOf(RemoteOperationError)
      const plain: unknown = await client.request('plain', {}, z.unknown()).catch((error: unknown) => error)
      expect(plain).toBeInstanceOf(RemoteOperationError)
      expect((plain as RemoteOperationError).code).toBeUndefined()
      await expect(client.request('non-error', {}, z.unknown())).rejects.toThrow('plain string rejection')
    } finally { await Promise.all([client.dispose(), server.dispose()]) }
  })

  it('refuses to serve calls and bounds concurrent handler operations', async () => {
    const left = new PassThrough()
    const right = new PassThrough()
    const client = new SshRpcPeer(right, left)
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    const server = new SshRpcPeer(left, right, 1024 * 1024, 1, async (method: string) => {
      if (method === 'blocked') await release.promise
      return null
    })
    try {
      await expect(server.request('probe', {}, z.null())).rejects.toThrow('SSH client does not serve calls')
      const blocked = client.request('blocked', {}, z.null())
      await expect(client.request('overflow', {}, z.null())).rejects.toThrow('SSH active request limit exceeded')
      release.resolve()
      expect(await blocked).toBeNull()
    } finally { await Promise.all([client.dispose(), server.dispose()]) }
  })

  it('propagates transport protocol failures and stream closure to both peers', async () => {
    const left = new PassThrough()
    const right = new PassThrough()
    const client = new SshRpcPeer(right, left)
    const server = new SshRpcPeer(left, right)
    try {
      const failed: PromiseWithResolvers<Error> = Promise.withResolvers()
      server.once('closed', (error: Error) => { failed.resolve(error) })
      const head = Buffer.alloc(4)
      head.writeUInt32BE(2, 0)
      left.write(Buffer.concat([head, Buffer.from('{}')]))
      expect((await failed.promise).message).toContain('not a control frame')
      await expect(server.request('late', {}, z.null())).rejects.toThrow()
      const ended: PromiseWithResolvers<Error> = Promise.withResolvers()
      client.once('closed', (error: Error) => { ended.resolve(error) })
      right.destroy()
      expect((await ended.promise).message).toBeTruthy()

      const finished = new PassThrough()
      const sink = new PassThrough()
      const clean = new SshRpcPeer(finished, sink)
      const settled: PromiseWithResolvers<Error> = Promise.withResolvers()
      clean.once('closed', (error: Error) => { settled.resolve(error) })
      finished.write(encodeControlFrame({ kind: 'done', value: null }))
      finished.end()
      expect((await settled.promise).message).toBe('SSH helper ended')
      await clean.dispose().catch(() => {})
    } finally { await Promise.allSettled([client.dispose(), server.dispose()]) }
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
