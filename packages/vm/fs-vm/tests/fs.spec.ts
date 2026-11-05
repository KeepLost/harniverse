/**
 * VmFileSystem tests over one scripted world filesystem: target resolution,
 * stat/lstat/list mapping, strict UTF-8 reads with encoding decisions, byte
 * bounds, guarded and policy-checked writes through the temp+rename path,
 * literal edits, and the typed error taxonomy.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { GuestFsError } from '@deepseek-ai/dsh-vm'
import type { GuestEntry, GuestStat, VmWorldDescriptor, VmWorldExit } from '@deepseek-ai/dsh-vm'
import { VmWorld } from '@deepseek-ai/dsh-vm'
import VmFileSystem from '../src/index.ts'
import type { VmWorldFs } from '@deepseek-ai/dsh-vm'

/** In-memory world filesystem with real op semantics and op recording. */
class MemoryWorldFs implements VmWorldFs {
  readonly files = new Map<string, Buffer>()
  readonly ops: string[] = []
  onWrite: (() => void) | undefined
  onRead: (() => void) | undefined
  onStat: (() => void) | undefined

  private ensure(path: string): void {
    if (!path.startsWith('/')) throw new GuestFsError('EINVAL', 22, `not absolute: ${path}`)
  }

  async readFile(path: string): Promise<Buffer> {
    this.ops.push(`read:${path}`)
    this.ensure(path)
    this.onRead?.()
    if (path.includes('/no-read')) throw new GuestFsError('EACCES', 13, 'permission denied')
    if (path.includes('/denied')) throw new GuestFsError('EACCES', 13, 'permission denied')
    if (path.includes('/eio')) throw new GuestFsError('EXDEV', 999, 'unmapped errno')
    if (path.includes('/raw')) throw 'not an error object'
    if (path.includes('/plain')) throw new Error('plain host-side failure')
    const file = this.files.get(path)
    if (file === undefined) {
      throw this.files.has(`${path}/`) ? new GuestFsError('EISDIR', 21, 'is a directory') : new GuestFsError('ENOENT', 2, 'no such file')
    }
    if (file.length > 16 * 1024) throw new GuestFsError('EFBIG', 27, 'above the wire cap')
    return file
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.ops.push(`write:${path}`)
    this.ensure(path)
    this.onWrite?.()
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (bytes.length > 16 * 1024) throw new GuestFsError('EFBIG', 27, 'above the wire cap')
    this.files.set(path, bytes)
  }

  async stat(path: string): Promise<GuestStat> {
    this.ops.push(`stat:${path}`)
    this.ensure(path)
    this.onStat?.()
    if (path.includes('/denied')) throw new GuestFsError('EACCES', 13, 'permission denied')
    if (path.includes('/eio')) throw new GuestFsError('EXDEV', 999, 'unmapped errno')
    if (path.includes('/raw')) throw 'not an error object'
    if (path.includes('/plain')) throw new Error('plain host-side failure')
    const file = this.files.get(path)
    if (file !== undefined) return { kind: 'file', size: file.length, mode: 0o644, mtimeMs: 1_000 }
    if (path === '/' || [...this.files.keys()].some(key => key.startsWith(`${path === '/' ? '' : path}/`))) {
      return { kind: 'dir', size: 0, mode: 0o755, mtimeMs: 1_000 }
    }
    throw new GuestFsError('ENOENT', 2, 'no such file')
  }

  async list(path: string): Promise<GuestEntry[]> {
    this.ops.push(`list:${path}`)
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length)
        if (rest.length > 0) names.add(rest.split('/')[0]!)
      }
    }
    return [...names].map((name) => {
      const child = `${prefix}${name}`
      const entry = this.files.get(child)
      return { name, kind: entry !== undefined ? 'file' as const : 'dir' as const }
    })
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.ops.push(`mkdir:${path}`)
    this.files.set(`${path}/`, Buffer.alloc(0))
    void options
  }

  async unlink(path: string): Promise<void> {
    this.ops.push(`unlink:${path}`)
    if (!this.files.delete(path)) throw new GuestFsError('ENOENT', 2, 'no such file')
  }

  async rmdir(path: string): Promise<void> {
    this.ops.push(`rmdir:${path}`)
    this.files.delete(`${path}/`)
  }

  async rename(from: string, to: string): Promise<void> {
    this.ops.push(`rename:${from}->${to}`)
    const file = this.files.get(from)
    if (file === undefined) throw new GuestFsError('ENOENT', 2, 'no such file')
    this.files.set(to, file)
    this.files.delete(from)
  }
}

class ScriptedWorld extends VmWorld {
  constructor(ctx: Context, readonly memory: VmWorldFs) {
    super(ctx)
  }

  override get descriptor(): VmWorldDescriptor {
    return { provider: 'fake', isolation: 'full', guestConfinement: 'landlock', hostHardened: true, readyMs: 0 }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 0
  }

  override async exec(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override async spawn(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override get fs(): VmWorldFs {
    return this.memory
  }

  override async destroy(): Promise<'clean'> {
    return 'clean'
  }
}

async function setup(mode: SandboxMode = 'workspace-write', root = '/workspace'): Promise<{ ctx: Context; memory: MemoryWorldFs; fs: VmFileSystem }> {
  const ctx = new Context()
  const memory = new MemoryWorldFs()
  new ScriptedWorld(ctx, memory)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  await ctx.plugin(VmFileSystem)
  return { ctx, memory, fs: ctx.fs as VmFileSystem }
}

const danger = { mode: 'danger-full-access' as const, workspaceRoot: '/workspace' }

describe('VmFileSystem', () => {
  it('resolves world-absolute targets lexically and refuses host-relative guesses', async () => {
    const { ctx, memory } = await setup()
    await expect(ctx.fs.resolve('/ws/../ws/a.txt')).resolves.toMatchObject({ displayPath: '/ws/a.txt' })
    await expect(ctx.fs.resolve('a.txt', { cwd: '/ws' })).resolves.toMatchObject({ displayPath: '/ws/a.txt' })
    await expect(ctx.fs.resolve('a.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(ctx.fs.resolve('/a//b/')).resolves.toMatchObject({ displayPath: '/a/b/' })
    expect(memory.ops).toEqual([])
    expect(String((await ctx.fs.resolve('/x')).targetKey)).toBe('/x')
  })

  it('maps stat and lstat through the contract vocabulary', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/a.txt', Buffer.from('hello'))
    const target = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.stat(target)).resolves.toMatchObject({ type: 'file', size: 5 })
    await expect(ctx.fs.stat(await ctx.fs.resolve('/workspace'))).resolves.toMatchObject({ type: 'directory' })
    await expect(ctx.fs.stat(await ctx.fs.resolve('/absent'))).resolves.toBeUndefined()
    await expect(ctx.fs.lstat('a.txt', { cwd: '/workspace' })).resolves.toMatchObject({ type: 'file', size: 5 })
    await expect(ctx.fs.lstat('  ', { cwd: '/workspace' })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('reads strict UTF-8 with BOM and line-ending decisions', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/a.txt', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('café\r\nline')]))
    const target = await ctx.fs.resolve('/workspace/a.txt')
    const decisions: unknown[] = []
    await expect(ctx.fs.readText(target, undefined, { onDecision: (decision) => { decisions.push(decision) } })).resolves.toBe('café\r\nline')
    expect(decisions).toEqual([{ encoding: 'utf-8', source: 'utf8', bom: true, eol: 'CRLF' }])
    memory.files.set('/workspace/bin.dat', Buffer.from([0xFF, 0xFE, 0x00, 0x01]))
    await expect(ctx.fs.readText(await ctx.fs.resolve('/workspace/bin.dat'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(ctx.fs.readText(target, undefined, { encoding: 'gb18030' })).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('bounds byte reads and rejects non-files', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/a.txt', Buffer.from('0123456789'))
    const target = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.readBytes(target, undefined, 5)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await expect(ctx.fs.readBytes(target, undefined, 10)).resolves.toBeInstanceOf(Uint8Array)
    await expect(ctx.fs.readBytes(await ctx.fs.resolve('/workspace'), undefined, 10)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('lists directories with follow-up child targets', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/sub/a.txt', Buffer.from('a'))
    memory.files.set('/workspace/b.txt', Buffer.from('b'))
    const entries = await ctx.fs.listDir(await ctx.fs.resolve('/workspace'))
    expect(entries.map(entry => [entry.name, entry.type, entry.target.displayPath])).toEqual([
      ['sub', 'directory', '/workspace/sub'],
      ['b.txt', 'file', '/workspace/b.txt'],
    ])
  })

  it('writes through temp+rename under the resolved policy with guards', async () => {
    const { ctx, memory } = await setup()
    const target = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.writeText(target, 'first', { kind: 'createIfAbsent' }, undefined, danger)).resolves.toMatchObject({ operation: 'create', before: null, after: 'first' })
    expect(memory.files.get('/workspace/a.txt')!.toString('utf8')).toBe('first')
    const tempOps = memory.ops.filter(op => op.startsWith('write:'))
    expect(tempOps.every(op => op.includes('.dsh-'))).toBe(true)
    expect(memory.ops.some(op => op.startsWith('rename:'))).toBe(true)
    await expect(ctx.fs.writeText(target, 'second', { kind: 'createIfAbsent' }, undefined, danger)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const version = (await ctx.fs.stat(target))!.version
    await expect(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: version.replace(/.$/, '9') as never }, undefined, danger)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(ctx.fs.writeText(target, 'second\r\nmore', { kind: 'replaceIfVersion', version }, undefined, danger)).resolves.toMatchObject({ operation: 'update', before: 'first', after: 'second\nmore' })
    await expect(ctx.fs.writeText(await ctx.fs.resolve('/workspace'), 'x', undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('denies writes by the host-checked policy', async () => {
    const { ctx, memory } = await setup()
    const inside = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.writeText(inside, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: '/workspace' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(ctx.fs.writeText(inside, 'x', undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/other' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(ctx.fs.writeText(inside, 'x', undefined, undefined, danger)).resolves.toMatchObject({ operation: 'create' })
    expect(memory.files.get('/workspace/a.txt')!.toString('utf8')).toBe('x')
  })

  it('reports the deployment sandbox mode as its capability fact', async () => {
    const { ctx } = await setup('read-only')
    expect(ctx.fs.sandboxMode).toBe('read-only')
  })

  it('applies literal edits with match discipline and normalization', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/a.txt', Buffer.from('one\r\ntwo\r\none'))
    const target: FsTarget = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.editText(target, { oldString: 'three', newString: 'x', replaceAll: false }, undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(ctx.fs.editText(target, { oldString: 'one', newString: 'x', replaceAll: false }, undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    await expect(ctx.fs.editText(target, { oldString: 'one\r\n', newString: '1\n', replaceAll: true }, undefined, undefined, danger)).resolves.toMatchObject({ before: 'one\ntwo\none', after: '1\ntwo\none' })
    expect(memory.files.get('/workspace/a.txt')!.toString('utf8')).toBe('1\ntwo\none')
    const version = (await ctx.fs.stat(target))!.version
    await expect(ctx.fs.editText(target, { oldString: 'two', newString: '2', replaceAll: false }, { version: `${version}!` as never }, undefined, danger)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(ctx.fs.editText(await ctx.fs.resolve('/workspace/absent.txt'), { oldString: 'a', newString: 'b', replaceAll: false }, undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('maps world errno facts onto the typed error taxonomy', async () => {
    const { ctx, memory } = await setup()
    const target = await ctx.fs.resolve('/gone.txt')
    await expect(ctx.fs.readText(target)).rejects.toBeInstanceOf(FsError)
    await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    memory.files.set('/workspace/denied.txt', Buffer.from('x'))
    await expect(ctx.fs.readText(await ctx.fs.resolve('/workspace/denied.txt'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(ctx.fs.writeText(await ctx.fs.resolve('/workspace/payload.txt'), 'x'.repeat(20 * 1024), undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('serves fileUrl and contains from the lexical identity', async () => {
    const { ctx } = await setup()
    const target = await ctx.fs.resolve('/workspace/a.txt')
    expect(ctx.fs.fileUrl(target)).toBe('file:///workspace/a.txt')
    const parent = await ctx.fs.resolve('/workspace')
    expect(ctx.fs.contains(parent, target)).toBe(true)
    expect(ctx.fs.contains(parent, await ctx.fs.resolve('/elsewhere/b.txt'))).toBe(false)
    expect(ctx.fs.contains(parent, parent)).toBe(true)
  })

  it('accepts explicit UTF-8 encoding names and reads empty files', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/empty.txt', Buffer.alloc(0))
    const target = await ctx.fs.resolve('/workspace/empty.txt')
    for (const encoding of ['utf-8', 'utf8', undefined]) {
      await expect(ctx.fs.readText(target, undefined, encoding === undefined ? undefined : { encoding })).resolves.toBe('')
    }
  })

  it('writes under the resolved default policy and honors the workspace-root edge', async () => {
    const { ctx, memory } = await setup('workspace-write', '/workspace')
    const inside = await ctx.fs.resolve('/workspace/a.txt')
    await expect(ctx.fs.writeText(inside, 'default-policy')).resolves.toMatchObject({ operation: 'create' })
    const rootFile = await ctx.fs.resolve('/workspace')
    await expect(ctx.fs.writeText(rootFile, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: '/workspace' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(memory.files.get('/workspace/a.txt')!.toString('utf8')).toBe('default-policy')
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.fs.lstat('a.txt', { cwd: '/workspace' }, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('keeps the diff basis null for oversized or binary priors', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/big.txt', Buffer.alloc(20 * 1024, 0x61))
    const big = await ctx.fs.resolve('/workspace/big.txt')
    await expect(ctx.fs.writeText(big, 'replacement', undefined, undefined, danger)).resolves.toMatchObject({ before: null, after: 'replacement' })
    memory.files.set('/workspace/bin.dat', Buffer.from([0xFF, 0x00]))
    const bin = await ctx.fs.resolve('/workspace/bin.dat')
    await expect(ctx.fs.writeText(bin, 'text-now', undefined, undefined, danger)).resolves.toMatchObject({ before: null, after: 'text-now' })
    memory.files.set('/workspace/denied.txt', Buffer.from('x'))
    const denied = await ctx.fs.resolve('/workspace/denied.txt')
    await expect(ctx.fs.readText(denied)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('aborts between the temp write and the rename', async () => {
    const { ctx, memory } = await setup()
    const target = await ctx.fs.resolve('/workspace/a.txt')
    const controller = new AbortController()
    memory.onWrite = () => { controller.abort() }
    await expect(ctx.fs.writeText(target, 'half-written', undefined, controller.signal, danger)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    memory.onWrite = undefined
  })

  it('maps unmapped errnos to FS_IO_ERROR and wraps non-error throws', async () => {
    const { ctx } = await setup()
    await expect(ctx.fs.readText(await ctx.fs.resolve('/eio.txt'))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(ctx.fs.readText(await ctx.fs.resolve('/raw.txt'))).rejects.toThrow('not an error object')
  })

  it('rejects every operation whose signal already aborted', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/a.txt', Buffer.from('x'))
    const target = await ctx.fs.resolve('/workspace/a.txt')
    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.fs.resolve('a.txt', { cwd: '/workspace', signal: aborted.signal })).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.stat(target, aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.readText(target, aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    const stream = await ctx.fs.streamText(target)
    await stream[Symbol.asyncIterator]().next()
    await expect(ctx.fs.readText(target, aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.readBytes(target, aborted.signal, 10)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.listDir(await ctx.fs.resolve('/workspace'), aborted.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.writeText(target, 'y', undefined, aborted.signal, danger)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false }, undefined, aborted.signal, danger)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('rejects a guarded write whose file vanished after the observation', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/gone.txt', Buffer.from('x'))
    const target = await ctx.fs.resolve('/workspace/gone.txt')
    const version = (await ctx.fs.stat(target))!.version
    memory.files.delete('/workspace/gone.txt')
    await expect(ctx.fs.writeText(target, 'revive', { kind: 'replaceIfVersion', version }, undefined, danger)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('covers the dir-stat size omission and mid-operation aborts', async () => {
    const { ctx, memory } = await setup()
    memory.files.set('/workspace/dir-marker', Buffer.alloc(0))
    const dirStat = await ctx.fs.stat(await ctx.fs.resolve('/workspace'))
    if (dirStat === undefined) throw new Error('dir stat unexpectedly absent')
    expect(dirStat).toMatchObject({ type: 'directory' })
    expect('size' in dirStat).toBe(false)

    memory.files.set('/workspace/a.txt', Buffer.from('x'))
    const target = await ctx.fs.resolve('/workspace/a.txt')
    const midRead = new AbortController()
    memory.onRead = () => { midRead.abort() }
    await expect(ctx.fs.readText(target, midRead.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    memory.onRead = undefined

    memory.files.set('/workspace/writable.txt', Buffer.from('y'))
    const writeTarget = await ctx.fs.resolve('/workspace/writable.txt')
    const midStat = new AbortController()
    memory.onStat = () => { midStat.abort() }
    await expect(ctx.fs.writeText(writeTarget, 'z', undefined, midStat.signal, danger)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    memory.onStat = undefined

    await expect(ctx.fs.writeText(await ctx.fs.resolve('/workspace/denied.txt'), 'c', undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    memory.files.set('/workspace/no-read.txt', Buffer.from('n'))
    await expect(ctx.fs.writeText(await ctx.fs.resolve('/workspace/no-read.txt'), 'c', undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('covers lstat absence, directories, plain errors, and lock contention', async () => {
    const { ctx, memory } = await setup()
    await expect(ctx.fs.lstat('/absent.txt')).resolves.toBeUndefined()
    memory.files.set('/workspace/inner.txt', Buffer.from('i'))
    const dirLstat = await ctx.fs.lstat('/workspace')
    if (dirLstat === undefined) throw new Error('dir lstat unexpectedly absent')
    expect(dirLstat).toMatchObject({ type: 'directory' })
    expect('size' in dirLstat).toBe(false)
    await expect(ctx.fs.readText(await ctx.fs.resolve('/plain.txt'))).rejects.toThrow('plain host-side failure')

    const single = await ctx.fs.resolve('/workspace/single.txt')
    memory.files.set('/workspace/single.txt', Buffer.from('one match'))
    await expect(ctx.fs.editText(single, { oldString: 'one', newString: '1', replaceAll: false }, undefined, undefined, danger)).resolves.toMatchObject({ before: 'one match', after: '1 match' })

    await expect(ctx.fs.editText(await ctx.fs.resolve('/workspace'), { oldString: 'x', newString: 'y', replaceAll: false }, undefined, undefined, danger)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })

    const defaulted = await ctx.fs.resolve('/workspace/default-edit.txt')
    memory.files.set('/workspace/default-edit.txt', Buffer.from('d'))
    await expect(ctx.fs.editText(defaulted, { oldString: 'd', newString: 'e', replaceAll: false })).resolves.toMatchObject({ after: 'e' })

    const rooted = await ctx.fs.resolve('/etc/hostname')
    await expect(ctx.fs.writeText(rooted, 'x', undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/' })).resolves.toMatchObject({ operation: 'create' })

    const contended = await ctx.fs.resolve('/workspace/contended.txt')
    const first = ctx.fs.writeText(contended, 'first', undefined, undefined, danger)
    const second = ctx.fs.writeText(contended, 'second', undefined, undefined, danger)
    await Promise.all([first, second])
    expect(memory.files.get('/workspace/contended.txt')!.toString('utf8')).toBe('second')
  })

  it('propagates aborts as FS_ABORTED', async () => {
    const { ctx, memory } = await setup()
    const target = await ctx.fs.resolve('/workspace/a.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.fs.writeText(target, 'x', undefined, controller.signal, danger)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    memory.files.set('/workspace/b.txt', Buffer.from('kept'))
    const kept = await ctx.fs.resolve('/workspace/b.txt')
    expect((await ctx.fs.readText(kept, undefined)).length).toBeGreaterThan(0)
    await expect(ctx.fs.readText(kept, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})
