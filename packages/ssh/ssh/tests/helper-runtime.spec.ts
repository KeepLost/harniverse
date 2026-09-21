/** Helper wire behavior over in-memory streams: handshake rules, fs operations, sandbox policy, and iterator bounds. */
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runSshHelper } from '../src/helper.ts'
import { SshRpcPeer } from '../src/protocol.ts'
import { editResultSchema, entriesSchema, infoSchema, pathInfoSchema, targetSchema, writeResultSchema } from '../src/schemas.ts'
import { createHelper, profile } from './fixtures/helper.ts'

const nextSchema = z.object({ done: z.boolean(), value: z.string() }).strict()
const policy = (workspaceRoot: string) => ({ mode: 'workspace-write' as const, workspaceRoot })

describe('SSH helper handshake', () => {
  it('rejects operations before hello, duplicate hellos, and unknown operations', async () => {
    const test = await createHelper({ handshake: false })
    try {
      await expect(test.request('heartbeat', {}, z.null())).rejects.toThrow('not accepting')
      await test.hello()
      await expect(test.request('heartbeat', {}, z.null())).resolves.toBeNull()
      await expect(test.hello()).rejects.toThrow('already initialized')
      await expect(test.request('machine.mcp', { server: 'x', method: 'resources/list' }, z.unknown())).rejects.toThrow('excluded by captured Profile')
      await expect(test.request('machine.skill', { name: 'x' }, z.unknown())).rejects.toThrow('excluded by captured Profile')
      await expect(test.request('machine.hook', { event: 'pre-tool', payload: {} }, z.null())).resolves.toBeNull()
      const target = { targetKey: join(test.root, 'file'), displayPath: join(test.root, 'file') }
      await expect(test.request('mystery', { target }, z.unknown())).rejects.toThrow('Unknown SSH helper operation: mystery')
      await test.request('close', {}, z.null())
      await expect(test.request('fs.stat', { target }, z.unknown())).rejects.toThrow('not accepting')
      test.controller.abort()
      await test.running
    } finally { await test.close() }
  })

  it.each([
    ['protocol mismatch', { protocol: 2, workspace: 'SET', leaseMs: 3000, profile }, 'Invalid'],
    ['lease bound', { protocol: 1, workspace: 'SET', leaseMs: 1000, profile }, 'too_small'],
    ['unknown key', { protocol: 1, workspace: 'SET', leaseMs: 3000, profile, extra: true }, 'unrecognized_keys'],
    ['relative workspace', { protocol: 1, workspace: 'relative', leaseMs: 3000, profile }, 'Invalid'],
    ['host-local profile id', { protocol: 1, workspace: 'SET', leaseMs: 3000, profile: { ...profile, id: 'cordis' } }, 'Host-local'],
    ['missing workspace', { protocol: 1, workspace: '/nonexistent-workspace-w10', leaseMs: 3000, profile }, 'SSH workspace must exist'],
  ])('rejects a hello with %s', async (_name, payload, message) => {
    const test = await createHelper({ handshake: false })
    try {
      await expect(test.request('hello', { ...payload, workspace: payload.workspace === 'SET' ? test.root : payload.workspace }, z.unknown()))
        .rejects.toThrow(message)
      await expect(test.request('fs.stat', { target: { targetKey: '/', displayPath: '/' } }, z.unknown())).rejects.toThrow('not accepting')
    } finally { await test.close() }
  })

  it('fails the handshake when the machine manifest is unreadable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'w10-manifest-')))
    const entry = join(root, 'helper.js')
    await writeFile(entry, 'fixture')
    const input = new PassThrough()
    const output = new PassThrough()
    const controller = new AbortController()
    const running = runSshHelper({ input, output, entryPath: entry, signal: controller.signal })
    const peer = new SshRpcPeer(output, input)
    try {
      await expect(peer.request('hello', { protocol: 1, workspace: root, leaseMs: 3000, profile }, z.unknown())).rejects.toThrow('ENOENT')
    } finally {
      controller.abort()
      await peer.dispose().catch(() => {})
      await running.catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires a POSIX target and settles immediately when pre-aborted', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(runSshHelper({ input: new PassThrough(), output: new PassThrough(), entryPath: '/x', signal: new AbortController().signal }))
        .rejects.toThrow('SSH target must be Linux or macOS')
    } finally {
      Object.defineProperty(process, 'platform', { value: platform?.value, configurable: true })
    }
    const controller = new AbortController()
    controller.abort(new Error('stopped before start'))
    await expect(runSshHelper({ input: new PassThrough(), output: new PassThrough(), entryPath: '/x', signal: controller.signal })).resolves.toBeUndefined()
  })

  it('abandons a helper closed before the handshake and expires an idle lease', async () => {
    const quiet = await createHelper({ handshake: false })
    try {
      quiet.controller.abort()
      await quiet.running
    } finally { await quiet.close() }
    const leased = await createHelper({ handshake: false })
    try {
      await leased.peer.request('hello', { protocol: 1, workspace: leased.root, leaseMs: 3000, profile }, z.unknown())
      const closed: PromiseWithResolvers<Error> = Promise.withResolvers()
      leased.peer.once('closed', (error: Error) => { closed.resolve(error) })
      expect((await closed.promise).message).toBeTruthy()
      await leased.running
    } finally { await leased.close() }
  }, 10_000)
})

describe('SSH helper filesystem operations', () => {
  it('resolves targets and reports metadata through the negotiated workspace', async () => {
    const test = await createHelper()
    try {
      await writeFile(join(test.root, 'abc'), 'abc')
      await writeFile(join(test.root, 'data'), 'abcdef')
      await symlink(join(test.root, 'data'), join(test.root, 'link'))
      const direct = await test.request('fs.resolve', { path: 'link', cwd: test.root }, targetSchema)
      expect(direct.targetKey).toBe(join(test.root, 'data'))
      expect(await test.request('fs.lstat', { path: 'link' }, pathInfoSchema)).toMatchObject({ type: 'symlink' })
      expect(await test.request('fs.lstat', { path: 'absent' }, pathInfoSchema.nullable())).toBeNull()
      expect(await test.request('fs.stat', { target: direct }, infoSchema)).toMatchObject({ type: 'file', size: 6 })
      const missing = await test.request('fs.resolve', { path: 'absent' }, targetSchema)
      expect(await test.request('fs.stat', { target: missing }, infoSchema.nullable())).toBeNull()
      expect(Buffer.from(await test.request('fs.readBytes', { target: direct, maxBytes: 16 }, z.string()), 'base64').toString()).toBe('abcdef')
      expect(Buffer.from(await test.request('fs.readBytes', { target: direct }, z.string()), 'base64').toString()).toBe('abcdef')
      expect(Buffer.from(await test.request('fs.readBytes', { target: await test.request('fs.resolve', { path: 'abc' }, targetSchema), maxBytes: 3 }, z.string()), 'base64').toString()).toBe('abc')
      await expect(test.request('fs.readBytes', { target: direct, maxBytes: -1 }, z.string())).rejects.toThrow()
      const directory = await test.request('fs.resolve', { path: '.' }, targetSchema)
      const names = (await test.request('fs.list', { target: directory }, entriesSchema)).map(entry => entry.name)
      expect(names).toContain('data')
      expect(names).toContain('link')
    } finally { await test.close() }
  })

  it('preserves guarded write and edit outcomes across RPC', async () => {
    const test = await createHelper()
    try {
      const target = await test.request('fs.resolve', { path: 'file.txt' }, targetSchema)
      const created = await test.request('fs.write', { target, content: 'first', policy: policy(test.root), expected: { kind: 'createIfAbsent' } }, writeResultSchema)
      expect(created).toMatchObject({ operation: 'create', before: null, after: 'first' })
      await expect(test.request('fs.write', { target, content: 'stale', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: 'stale' } }, writeResultSchema))
        .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      const updated = await test.request('fs.write', { target, content: 'second', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: created.version } }, writeResultSchema)
      expect(updated.operation).toBe('update')
      const edited = await test.request('fs.edit', { target, edit: { oldString: 'second', newString: 'third', replaceAll: false }, expected: { version: updated.version }, policy: policy(test.root) }, editResultSchema)
      expect(edited.after).toBe('third')
      expect((await test.request('fs.edit', { target, edit: { oldString: 'third', newString: 'fourth', replaceAll: true }, policy: policy(test.root) }, editResultSchema)).after).toBe('fourth')
      await expect(test.request('fs.edit', { target, edit: { oldString: 'fourth', newString: 'fifth', replaceAll: false }, expected: { version: 'stale' }, policy: policy(test.root) }, editResultSchema))
        .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      await expect(test.request('fs.write', { target, content: 'denied' }, writeResultSchema)).rejects.toThrow()
      await expect(test.request('fs.write', { target, content: 'denied', policy: { mode: 'read-only', workspaceRoot: test.root } }, writeResultSchema))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(test.request('fs.write', { target, content: 'elsewhere', policy: policy('/other-workspace') }, writeResultSchema)).rejects.toThrow('differs from captured execution world')
    } finally { await test.close() }
  })

  it('routes sandbox policy resolution and rejects unconfined execution', async () => {
    const test = await createHelper()
    try {
      await expect(test.request('sandbox', { argv: ['/bin/sh', '-c', 'true'], policy: { mode: 'danger-full-access', workspaceRoot: test.root } }, z.unknown()))
        .rejects.toThrow('Unconfined execution needs no wrapper')
      await expect(test.request('sandbox', { argv: ['/bin/sh', '-c', 'true'], policy: policy('/other') }, z.unknown()))
        .rejects.toThrow('differs from captured execution world')
      const confined = await test.request('sandbox', { argv: ['/bin/sh', '-c', 'true'], policy: policy(test.root) }, z.object({
        argv: z.array(z.string()), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.unknown()),
      }))
      expect(confined.argv.length).toBeGreaterThan(2)
      const resolved = await test.request('executable', { command: 'sh' }, z.string())
      expect(resolved).toContain('sh')
    } finally { await test.close() }
  })
})

describe('SSH helper text stream iterators', () => {
  it('streams chunks to completion and forgets finished iterators', async () => {
    const test = await createHelper()
    try {
      await writeFile(join(test.root, 'text'), 'streamed')
      const target = await test.request('fs.resolve', { path: 'text' }, targetSchema)
      const id = await test.request('fs.stream', { target }, z.uuid())
      expect(await test.request('fs.next', { id }, nextSchema)).toEqual({ done: false, value: 'streamed' })
      let next = await test.request('fs.next', { id }, nextSchema)
      while (!next.done) next = await test.request('fs.next', { id }, nextSchema)
      expect(next).toEqual({ done: true, value: '' })
      await expect(test.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
      const early = await test.request('fs.stream', { target }, z.uuid())
      await test.request('fs.streamClose', { id: early }, z.null())
      await expect(test.request('fs.next', { id: early }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
      await expect(test.request('fs.next', { id: '00000000-0000-4000-8000-000000000000' }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { await test.close() }
  })

  it('bounds concurrent text iterators and cancels allocations racing closure', async () => {
    const test = await createHelper()
    try {
      await writeFile(join(test.root, 'text'), 'x')
      const target = await test.request('fs.resolve', { path: 'text' }, targetSchema)
      const held = await Promise.all(Array.from({ length: 64 }, () => test.request('fs.stream', { target }, z.uuid())))
      expect(held).toHaveLength(64)
      await expect(test.request('fs.stream', { target }, z.uuid())).rejects.toThrow('SSH text iterator capacity exhausted')
      await test.request('close', {}, z.null())
      test.controller.abort()
      await test.running
    } finally { await test.close() }
    const racing = await createHelper()
    try {
      await writeFile(join(racing.root, 'text'), 'x')
      const target = await racing.request('fs.resolve', { path: 'text' }, targetSchema)
      const allocation = racing.request('fs.stream', { target }, z.uuid())
      await racing.request('close', {}, z.null())
      await expect(allocation).rejects.toThrow('SSH text iterator allocation cancelled')
      racing.controller.abort()
      await racing.running
    } finally { await racing.close() }
    const shared = await createHelper()
    try {
      await writeFile(join(shared.root, 'text'), 'x')
      const target = await shared.request('fs.resolve', { path: 'text' }, targetSchema)
      await Promise.all(Array.from({ length: 63 }, () => shared.request('fs.stream', { target }, z.uuid())))
      const results = await Promise.allSettled([
        shared.request('fs.stream', { target }, z.uuid()),
        shared.request('fs.stream', { target }, z.uuid()),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
      expect(String(failure.reason)).toContain('SSH text iterator allocation cancelled')
    } finally { await shared.close() }
  })
})
