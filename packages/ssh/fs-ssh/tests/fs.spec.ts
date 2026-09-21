/** Remote filesystem provider over scripted SSH requests: passthrough, bounds, and error mapping. */
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import SshFileSystem from '../src/index.ts'

interface Call {
  method: string
  params: Record<string, unknown>
  signal?: AbortSignal
}

const contexts: Context[] = []

const mount = async (script: (call: Call) => unknown): Promise<{ fs: SshFileSystem; calls: Call[]; controller: AbortController }> => {
  const ctx = new Context()
  contexts.push(ctx)
  const calls: Call[] = []
  const controller = new AbortController()
  ctx.provide('ssh', {
    request: async <T>(method: string, params: Record<string, unknown>, schema: { parse: (value: unknown) => T },
      signal?: AbortSignal): Promise<T> => {
      const call: Call = signal === undefined ? { method, params } : { method, params, signal }
      calls.push(call)
      const value = await script(call)
      if (value instanceof Error) throw value
      return schema.parse(value)
    },
    signal: controller.signal,
  } as never)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'read-only',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/machine/work' }),
  } as never)
  await ctx.plugin(SshFileSystem)
  return { fs: (ctx as unknown as { fs: SshFileSystem }).fs, calls, controller }
}

const target: FsTarget = { targetKey: FsTargetKey('/machine/work/file.txt'), displayPath: 'file.txt' }
const info = { version: 'v1', type: 'file' as const, size: 6 }
const pathInfo = { version: 'v1', type: 'symlink' as const }

describe('SSH filesystem provider', () => {
  afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

  it('resolves targets and reports metadata with null mapped to undefined', async () => {
    const seen: Record<string, number> = {}
    const { fs, calls } = await mount((call) => {
      seen[call.method] = (seen[call.method] ?? 0) + 1
      if (call.method === 'fs.resolve') return { targetKey: '/machine/work/file.txt', displayPath: 'file.txt' }
      if (call.method === 'fs.stat') return seen['fs.stat'] === 1 ? info : null
      if (call.method === 'fs.lstat') return seen['fs.lstat'] === 1 ? pathInfo : null
      return null
    })
    expect(await fs.resolve('file.txt', { cwd: '/machine/work' })).toEqual(target)
    expect(calls[0]).toMatchObject({ method: 'fs.resolve', params: { path: 'file.txt', cwd: '/machine/work' } })
    expect(fs.processPath(target)).toBe('/machine/work/file.txt')
    expect(fs.fileUrl(target)).toBe(`file://${target.targetKey}`)
    expect(fs.contains({ ...target, targetKey: FsTargetKey('/machine/work') }, target)).toBe(true)
    expect(fs.contains(target, { ...target, targetKey: FsTargetKey('/machine/work') })).toBe(false)
    expect(fs.contains(target, target)).toBe(true)
    expect(await fs.stat(target)).toEqual(info)
    expect(await fs.stat({ ...target, targetKey: FsTargetKey('/machine/work/absent') })).toBeUndefined()
    expect(await fs.lstat('link')).toEqual(pathInfo)
    expect(await fs.lstat('absent')).toBeUndefined()
    expect(fs.sandboxMode).toBe('read-only')
  })

  it('streams text with early close and bounds reads to 8 MiB', async () => {
    const chunks = ['first ', 'second']
    const { fs, calls } = await mount((call) => {
      if (call.method === 'fs.stream') return '00000000-0000-0000-0000-000000000000'
      if (call.method === 'fs.next') {
        const value = chunks.shift()
        return value === undefined ? { done: true, value: '' } : { done: false, value }
      }
      if (call.method === 'fs.streamClose') throw new Error('stream already gone')
      return null
    })
    expect(await fs.readText(target)).toBe('first second')
    expect(calls.map(call => call.method)).toEqual(['fs.stream', 'fs.next', 'fs.next', 'fs.next'])

    chunks.push('early')
    for await (const chunk of await fs.streamText(target)) {
      expect(chunk).toBe('early')
      break
    }
    expect(calls.at(-1)).toMatchObject({ method: 'fs.streamClose', params: { id: '00000000-0000-0000-0000-000000000000' } })

    const oversized = ['x'.repeat(5 * 1024 * 1024), 'y'.repeat(5 * 1024 * 1024)]
    const bounded = await mount((call) => {
      if (call.method === 'fs.stream') return 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      if (call.method === 'fs.next') {
        const value = oversized.shift()
        return value === undefined ? { done: true, value: '' } : { done: false, value }
      }
      return null
    })
    await expect(bounded.fs.readText(target)).rejects.toMatchObject({ name: 'FsError', code: 'FS_TOO_LARGE' })
  })

  it('clamps byte reads and lists directories', async () => {
    const { fs, calls } = await mount((call) => {
      if (call.method === 'fs.readBytes') return Buffer.from('abcdef').toString('base64')
      if (call.method === 'fs.list') return [{ name: 'file.txt', type: 'file', target }]
      return null
    })
    expect(Buffer.from(await fs.readBytes(target, undefined, 600_000)).toString()).toBe('abcdef')
    expect((calls[0]!.params as { maxBytes?: number }).maxBytes).toBe(512 * 1024)
    expect(Buffer.from(await fs.readBytes(target, undefined, 128)).toString()).toBe('abcdef')
    expect((calls.at(-1)!.params as { maxBytes?: number }).maxBytes).toBe(128)
    expect(await fs.listDir(target)).toEqual([{ name: 'file.txt', type: 'file', target }])
  })

  it('writes and edits under the machine-resolved default policy', async () => {
    const write = { operation: 'create' as const, before: null, after: 'first', version: 'v1' }
    const edit = { before: 'first', after: 'second', version: 'v2' }
    const { fs, calls } = await mount((call) => {
      if (call.method === 'fs.write') return write
      if (call.method === 'fs.edit') return edit
      return null
    })
    expect(await fs.writeText(target, 'first', { kind: 'createIfAbsent' })).toEqual(write)
    expect(calls.at(-1)?.params).toMatchObject({ expected: { kind: 'createIfAbsent' }, policy: { mode: 'workspace-write', workspaceRoot: '/machine/work' } })
    const explicit = { mode: 'read-only' as const, workspaceRoot: '/machine/work' }
    expect(await fs.writeText(target, 'x', undefined, undefined, explicit)).toEqual(write)
    expect((calls.at(-1)!.params as { policy?: unknown }).policy).toEqual(explicit)
    expect(await fs.editText(target, { oldString: 'first', newString: 'second', replaceAll: false }, { version: 'v1' as FsVersion })).toEqual(edit)
    expect(calls.at(-1)?.params).toMatchObject({ expected: { version: 'v1' }, policy: { mode: 'workspace-write', workspaceRoot: '/machine/work' } })
  })

  it('maps remote failures onto filesystem error codes', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    const { fs } = await mount((call) => {
      if (call.method === 'fs.stat' && ((call.params.target as { targetKey: string }).targetKey).includes('denied')) throw Object.assign(new RemoteOperationError('no access'), { code: 'FS_PERMISSION_DENIED' })
      if (call.method === 'fs.stat' && ((call.params.target as { targetKey: string }).targetKey).includes('plain')) throw new Error('socket reset')
      if (call.method === 'fs.stat' && ((call.params.target as { targetKey: string }).targetKey).includes('cancelled')) throw new Error('mid-flight cancellation')
      if (call.method === 'fs.stat' && ((call.params.target as { targetKey: string }).targetKey).includes('uncoded')) throw Object.assign(new RemoteOperationError('mismatch'), { code: 'MCP_OTHER' })
      return null
    })
    await expect(fs.stat({ ...target, targetKey: FsTargetKey('/denied') })).rejects.toMatchObject({ name: 'FsError', code: 'FS_PERMISSION_DENIED' })
    await expect(fs.stat({ ...target, targetKey: FsTargetKey('/plain') })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(fs.stat({ ...target, targetKey: FsTargetKey('/cancelled') }, aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(fs.stat({ ...target, targetKey: FsTargetKey('/uncoded') })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    const failure = await fs.stat({ ...target, targetKey: FsTargetKey('/plain') }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FsError)
    expect((failure as FsError).cause).toBeInstanceOf(Error)

    const throwing = await mount((call) => {
      if (call.method === 'fs.stat') throw 'plain string failure'
      return null
    })
    await expect(throwing.fs.stat(target)).rejects.toMatchObject({ name: 'FsError', code: 'FS_IO_ERROR', message: 'plain string failure' })
  })
})
