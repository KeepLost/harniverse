/**
 * Service-level create specs for the workspace file-editing Remote:
 * exclusive file/directory creation, the intermediate-directory walk,
 * `exists` refusals, containment fences (`.git`, escapes, root-naming,
 * symlinked or non-directory segments), and the no-event post-condition,
 * over the real local fs backend and a controlled workspace-registry stub.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkspaceFileWriteService from '../src/index.ts'
import type { WorkspaceFileSavedEvent } from '../src/index.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

let root: string | undefined
let ctx: Context | undefined
let savedEvents: WorkspaceFileSavedEvent[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-workspace-file-create-'))
  savedEvents = []
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the service over the real local backend plus a controlled registry stub. */
async function harness() {
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root as string })
  const canonical = realpathSync.native(root as string)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === 'ws-0' ? { id: 'ws-0', path: canonical } : undefined),
  })
  await ctx.plugin(WorkspaceFileWriteService)
  ctx.on('workspace-file/saved', (event) => { savedEvents.push(event) })
  return { service: ctx.workspaceFileWrite, ws: WorkspaceId('ws-0'), signal: () => new AbortController().signal }
}

describe('workspace-file-write createFile', () => {
  it('creates an empty regular file at the workspace root', async () => {
    const { service, ws, signal } = await harness()
    await expect(service.createFile(ws, 'new.md', signal())).resolves.toEqual({ created: true })
    expect(readFileSync(join(root ?? '.', 'new.md'), 'utf8')).toBe('')
    expect(statSync(join(root ?? '.', 'new.md')).isFile()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('publishes the new file owner-only through the backend staging', async () => {
    const { service, ws, signal } = await harness()
    await service.createFile(ws, 'mode.txt', signal())
    expect(statSync(join(root ?? '.', 'mode.txt')).mode & 0o777).toBe(0o600)
  })

  it('creates every absent intermediate directory one segment at a time', async () => {
    const { service, ws, signal } = await harness()
    await service.createFile(ws, 'a/b/c.md', signal())
    expect(statSync(join(root ?? '.', 'a')).isDirectory()).toBe(true)
    expect(statSync(join(root ?? '.', 'a/b')).isDirectory()).toBe(true)
    expect(readFileSync(join(root ?? '.', 'a/b/c.md'), 'utf8')).toBe('')
    // The created file opens through the editing Remote like any edited file.
    const opened = await service.open(ws, 'a/b/c.md', signal())
    expect(opened.content).toBe('')
    expect(opened.version).toMatch(/.+/u)
  })

  it('creates beneath pre-existing intermediate directories', async () => {
    await mkdir(join(root ?? '.', 'present'))
    const { service, ws, signal } = await harness()
    await service.createFile(ws, 'present/nested.txt', signal())
    expect(readFileSync(join(root ?? '.', 'present/nested.txt'), 'utf8')).toBe('')
  })

  it.each([
    ['existing file', async () => { await writeFile(join(root ?? '.', 'taken.md'), 'keep\n') }, 'taken.md'],
    ['existing directory', async () => { await mkdir(join(root ?? '.', 'dir')) }, 'dir'],
    ['symlink at the final path', async () => {
      await writeFile(join(root ?? '.', 'real.txt'), 'keep\n')
      await symlink(join(root ?? '.', 'real.txt'), join(root ?? '.', 'linked.txt'))
    }, 'linked.txt'],
  ])('refuses an existing final entry (%s) with exists and never overwrites', async (_name, arrange, path) => {
    await arrange()
    const { service, ws, signal } = await harness()
    await expect(service.createFile(ws, path, signal())).rejects.toMatchObject({ code: 'exists' })
    if (path === 'taken.md') expect(readFileSync(join(root ?? '.', 'taken.md'), 'utf8')).toBe('keep\n')
    if (path === 'linked.txt') expect(readFileSync(join(root ?? '.', 'real.txt'), 'utf8')).toBe('keep\n')
  })

  it.each([
    ['.git segment', '.git/config', 'git-dir'],
    ['escape', '../outside.txt', 'path-invalid'],
    ['absolute path', '/etc/motd', 'path-invalid'],
    ['empty path', '', 'path-invalid'],
    ['workspace root', '.', 'path-invalid'],
    ['dot-normalized root', 'a/..', 'path-invalid'],
  ])('refuses %s', async (_name, path, code) => {
    const { service, ws, signal } = await harness()
    await expect(service.createFile(ws, path, signal())).rejects.toMatchObject({ code })
  })

  it('refuses a symlinked intermediate directory with symlink', async () => {
    await mkdir(join(root ?? '.', 'real-dir'))
    await symlink(join(root ?? '.', 'real-dir'), join(root ?? '.', 'linked-dir'))
    const { service, ws, signal } = await harness()
    await expect(service.createFile(ws, 'linked-dir/file.txt', signal())).rejects.toMatchObject({ code: 'symlink' })
  })

  it('refuses a non-directory intermediate segment with path-invalid', async () => {
    await writeFile(join(root ?? '.', 'blocker'), 'x')
    const { service, ws, signal } = await harness()
    await expect(service.createFile(ws, 'blocker/child.md', signal())).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('refuses an unknown workspace', async () => {
    const { service, signal } = await harness()
    await expect(service.createFile(WorkspaceId('ws-none'), 'a.txt', signal())).rejects.toMatchObject({ code: 'workspace-unknown' })
  })
})

describe('workspace-file-write createDirectory', () => {
  it('creates the directory including absent intermediate segments', async () => {
    const { service, ws, signal } = await harness()
    await expect(service.createDirectory(ws, 'x/y/z', signal())).resolves.toEqual({ created: true })
    expect(statSync(join(root ?? '.', 'x/y/z')).isDirectory()).toBe(true)
    // The created directory immediately hosts an exclusive file create.
    await service.createFile(ws, 'x/y/z/empty.md', signal())
    expect(readFileSync(join(root ?? '.', 'x/y/z/empty.md'), 'utf8')).toBe('')
  })

  it('creates beneath a pre-existing intermediate directory', async () => {
    await mkdir(join(root ?? '.', 'present'))
    const { service, ws, signal } = await harness()
    await service.createDirectory(ws, 'present/inner', signal())
    expect(statSync(join(root ?? '.', 'present/inner')).isDirectory()).toBe(true)
  })

  it.each([
    ['existing directory', async () => { await mkdir(join(root ?? '.', 'taken')) }, 'taken'],
    ['existing file', async () => { await writeFile(join(root ?? '.', 'file.txt'), 'keep\n') }, 'file.txt'],
    ['symlink at the final path', async () => {
      await mkdir(join(root ?? '.', 'real-dir'))
      await symlink(join(root ?? '.', 'real-dir'), join(root ?? '.', 'linked-dir'))
    }, 'linked-dir'],
  ])('refuses an existing final entry (%s) with exists', async (_name, arrange, path) => {
    await arrange()
    const { service, ws, signal } = await harness()
    await expect(service.createDirectory(ws, path, signal())).rejects.toMatchObject({ code: 'exists' })
  })

  it.each([
    ['.git segment', '.git/objects', 'git-dir'],
    ['escape', '../outside', 'path-invalid'],
    ['absolute path', '/tmp/elsewhere', 'path-invalid'],
    ['empty path', '', 'path-invalid'],
  ])('refuses %s', async (_name, path, code) => {
    const { service, ws, signal } = await harness()
    await expect(service.createDirectory(ws, path, signal())).rejects.toMatchObject({ code })
  })

  it('refuses a symlinked intermediate directory with symlink', async () => {
    await mkdir(join(root ?? '.', 'real-dir'))
    await symlink(join(root ?? '.', 'real-dir'), join(root ?? '.', 'linked-dir'))
    const { service, ws, signal } = await harness()
    await expect(service.createDirectory(ws, 'linked-dir/deeper', signal())).rejects.toMatchObject({ code: 'symlink' })
  })
})

describe('workspace-file-write create post-conditions', () => {
  it('emits no saved event for either create', async () => {
    const { service, ws, signal } = await harness()
    await service.createDirectory(ws, 'notes', signal())
    await service.createFile(ws, 'notes/empty.md', signal())
    expect(savedEvents).toHaveLength(0)
  })
})
