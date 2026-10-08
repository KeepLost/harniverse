/**
 * Unit composition specs for the workspace file-editing Remote: path gates,
 * version CAS, encoding-faithful write-back, EOL handling, idempotency, and
 * the Agent notice, over the real local fs backend and a controlled
 * workspace-registry stub.
 */
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { encodeForWrite } from '@deepseek-ai/dsh-fs-codec'
import WorkspaceFileWriteService, { SOURCE_ID, noticeText } from '../src/index.ts'
import type { WorkspaceFileSavedEvent } from '../src/index.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

interface RemoteErrorLike {
  code: string
  message: string
  details: { currentVersion?: string }
}

/** Encode fixture text through the codec library (tests cannot reach iconv-lite directly). */
function enc(text: string, encoding: string): Buffer {
  const outcome = encodeForWrite(text, encoding)
  if (!outcome.ok) throw new Error(`fixture text is not representable in ${encoding}`)
  return Buffer.from(outcome.bytes)
}

/** One injected notice as recorded by the agents stub. */
interface RecordedNotice {
  text: string
  source: unknown
}

let root: string | undefined
let ctx: Context | undefined
let notices: RecordedNotice[]
let savedEvents: WorkspaceFileSavedEvent[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-workspace-file-write-'))
  notices = []
  savedEvents = []
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface HarnessOptions {
  /** Live-agent cwd values the notice path observes. */
  agentCwds?: readonly (string | undefined)[]
  /** Registered workspace paths; defaults to the harness tempdir. */
  workspacePaths?: readonly string[]
  /** Additional agents appended to the stub registry. */
  extraAgents?: object[]
}

/** Boot the service over the real local backend plus controlled registry/agents stubs. */
async function harness(options: HarnessOptions = {}) {
  const paths = options.workspacePaths ?? [root as string]
  const canonical = paths.map(path => realpathSync.native(path))
  const agentStubs = [
    ...(options.agentCwds ?? []).map((cwd, index) => ({
      id: `agent-${String(index)}`,
      session: { header: { ...(cwd === undefined ? {} : { cwd }) } },
      inject: (message: { content: Array<{ text: string }>; source: unknown }) => {
        notices.push({ text: message.content[0]?.text ?? '', source: message.source })
      },
    })),
    ...(options.extraAgents ?? []),
  ]
  ctx = new Context()
  const fsFiber = await ctx.plugin(LocalFileSystem, { cwd: root as string })
  // Deterministic legacy-decode coverage on a non-CN host (the backend's own
  // test seam for host priors).
  ;(ctx.fs as LocalFileSystem).resolvePriors = async () => ({
    localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN',
  })
  const byId = new Map(paths.map((_, index) => [
    `ws-${String(index)}`,
    { id: `ws-${String(index)}`, path: canonical[index] },
  ] as const))
  ctx.provide('workspaceRegistry', {
    get: (id: string) => byId.get(id as `ws-${string}`),
  })
  ctx.provide('agents', { list: () => agentStubs })
  await ctx.plugin(WorkspaceFileWriteService)
  ctx.on('workspace-file/saved', (event) => { savedEvents.push(event) })
  return {
    service: ctx.workspaceFileWrite,
    fsFiber,
    ws: WorkspaceId('ws-0'),
    signal: () => new AbortController().signal,
  }
}

/** The bounded-notice harness needs its extra agents to lead the list. */
async function stubOrderHarness(options: HarnessOptions) {
  const boom = options.extraAgents?.[0]
  const rest = (options.agentCwds ?? []).map((cwd, index) => ({
    id: `agent-${String(index)}`,
    session: { header: { ...(cwd === undefined ? {} : { cwd }) } },
    inject: (message: { content: Array<{ text: string }>; source: unknown }) => {
      notices.push({ text: message.content[0]?.text ?? '', source: message.source })
    },
  }))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root as string })
  ;(ctx.fs as LocalFileSystem).resolvePriors = async () => ({})
  const canonical = realpathSync.native(root as string)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === 'ws-0' ? { id: 'ws-0', path: canonical } : undefined),
  })
  ctx.provide('agents', { list: () => [boom, ...rest] })
  await ctx.plugin(WorkspaceFileWriteService)
  ctx.on('workspace-file/saved', (event) => { savedEvents.push(event) })
  return {
    service: ctx.workspaceFileWrite,
    ws: WorkspaceId('ws-0'),
    signal: () => new AbortController().signal,
  }
}

describe('workspace-file-write open', () => {
  it('returns LF content with version and decode facts', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'one\ntwo\n', 'utf8')
    const { service, ws, signal } = await harness()
    const result = await service.open(ws, 'a.txt', signal())
    expect(result.content).toBe('one\ntwo\n')
    expect(result.version).toMatch(/.+/u)
    expect(result.encoding).toBe('utf-8')
    expect(result.encodingSource).toBe('utf8')
    expect(result.bom).toBe(false)
    expect(result.eol).toBe('LF')
    expect(result.bytes).toBe(8)
  })

  it('collapses CRLF to LF and reports CRLF', async () => {
    await writeFile(join(root ?? '.', 'crlf.txt'), 'one\r\ntwo\r\n', 'utf8')
    const { service, ws, signal } = await harness()
    const result = await service.open(ws, 'crlf.txt', signal())
    expect(result.content).toBe('one\ntwo\n')
    expect(result.eol).toBe('CRLF')
  })

  it('preserves BOM facts for a UTF-8 BOM file', async () => {
    await writeFile(join(root ?? '.', 'bom.txt'), Buffer.concat([UTF8_BOM, Buffer.from('x\n', 'utf8')]))
    const { service, ws, signal } = await harness()
    const result = await service.open(ws, 'bom.txt', signal())
    expect(result.bom).toBe(true)
    expect(result.encodingSource).toBe('bom')
    expect(result.content).toBe('x\n')
  })

  it('decodes a legacy-encoded file and reports the decision', async () => {
    await writeFile(join(root ?? '.', 'gbk.txt'), enc('中文注释\n', 'gb18030'))
    const { service, ws, signal } = await harness()
    const result = await service.open(ws, 'gbk.txt', signal())
    expect(result.content).toBe('中文注释\n')
    expect(result.encoding).toBe('gb18030')
    expect(result.encodingSource).toBe('host')
  })

  it.each([
    ['mixed line endings', 'mix.txt', async () => { await writeFile(join(root ?? '.', 'mix.txt'), 'a\r\nb\n') }, 'mixed-eol'],
    ['oversized file', 'big.txt', async () => {
      await writeFile(join(root ?? '.', 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61))
    }, 'too-large'],
    ['missing entry', 'missing.txt', async () => {}, 'not-found'],
    ['directory target', 'subdir', async () => { await mkdir(join(root ?? '.', 'subdir')) }, 'not-regular'],
    ['.git segment', '.git/config', async () => {
      await mkdir(join(root ?? '.', '.git'), { recursive: true })
      await writeFile(join(root ?? '.', '.git/config'), 'x')
    }, 'git-dir'],
    ['escaping path', '../outside.txt', async () => {}, 'path-invalid'],
  ])('refuses %s', async (_name, path, arrange, code) => {
    await arrange()
    const { service, ws, signal } = await harness()
    await expect(service.open(ws, path, signal())).rejects.toMatchObject({ code })
  })

  it('refuses a symbolic link anywhere on the final spelling', async () => {
    await writeFile(join(root ?? '.', 'real.txt'), 'x\n')
    await symlink(join(root ?? '.', 'real.txt'), join(root ?? '.', 'link.txt'))
    const { service, ws, signal } = await harness()
    await expect(service.open(ws, 'link.txt', signal())).rejects.toMatchObject({ code: 'symlink' })
  })

  it('refuses an unknown workspace', async () => {
    const { service, signal } = await harness()
    await expect(service.open(WorkspaceId('ws-none'), 'a.txt', signal())).rejects.toMatchObject({ code: 'workspace-unknown' })
  })

  it('refuses binary content as not-text', async () => {
    await writeFile(join(root ?? '.', 'bin.txt'), Buffer.from([0x01, 0x00, 0x02, 0x00]))
    const { service, ws, signal } = await harness()
    await expect(service.open(ws, 'bin.txt', signal())).rejects.toMatchObject({ code: 'not-text' })
  })
})

describe('workspace-file-write stat', () => {
  it('reports the version or absence', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness()
    const present = await service.stat(ws, 'a.txt', signal())
    expect('version' in present).toBe(true)
    const absent = await service.stat(ws, 'gone.txt', signal())
    expect(absent).toEqual({ absent: true })
  })
})

describe('workspace-file-write save', () => {
  it('writes through the CAS and restores CRLF line endings', async () => {
    await writeFile(join(root ?? '.', 'crlf.txt'), 'one\r\ntwo\r\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'crlf.txt', signal())
    const saved = await service.save(ws, 'crlf.txt', {
      content: 'one\nTWO\n', baseVersion: opened.version, saveId: 'save-1',
    }, signal())
    expect(typeof saved.version).toBe('string')
    expect(readFileSync(join(root ?? '.', 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\n')
    expect(savedEvents).toHaveLength(1)
    expect(savedEvents[0]).toMatchObject({ workspaceId: ws, path: 'crlf.txt', version: saved.version })
  })

  it('writes back a legacy encoding without a BOM change', async () => {
    await writeFile(join(root ?? '.', 'gbk.txt'), enc('第一行\n', 'gb18030'))
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'gbk.txt', signal())
    const saved = await service.save(ws, 'gbk.txt', {
      content: '第一行\n第二行\n', baseVersion: opened.version, saveId: 'save-gbk',
    }, signal())
    expect(saved.version).not.toBe(opened.version)
    expect([...readFileSync(join(root ?? '.', 'gbk.txt'))]).toEqual([...enc('第一行\n第二行\n', 'gb18030')])
  })

  it('reproduces the UTF-8 byte order mark', async () => {
    await writeFile(join(root ?? '.', 'bom.txt'), Buffer.concat([UTF8_BOM, Buffer.from('a\n', 'utf8')]))
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'bom.txt', signal())
    await service.save(ws, 'bom.txt', { content: 'ab\n', baseVersion: opened.version, saveId: 'save-bom' }, signal())
    expect([...readFileSync(join(root ?? '.', 'bom.txt'))]).toEqual([...Buffer.concat([UTF8_BOM, Buffer.from('ab\n', 'utf8')])])
  })

  it('refuses a save over a changed file with the current version', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'v1\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'a.txt', signal())
    await writeFile(join(root ?? '.', 'a.txt'), 'v2 externally\n')
    const failure = await service.save(ws, 'a.txt', {
      content: 'mine\n', baseVersion: opened.version, saveId: 'save-stale',
    }, signal()).then(() => { throw new Error('expected refusal') }, (error: unknown) => error as RemoteErrorLike)
    expect(failure.code).toBe('stale-version')
    expect(failure.details.currentVersion).toMatch(/.+/u)
    expect(readFileSync(join(root ?? '.', 'a.txt'), 'utf8')).toBe('v2 externally\n')
  })

  it('replays a committed saveId without writing again', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'a.txt', signal())
    const first = await service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 'same' }, signal())
    const replayed = await service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 'same' }, signal())
    expect(replayed.version).toBe(first.version)
    expect(savedEvents).toHaveLength(1)
  })

  it('refuses a malformed saveId', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'a.txt', signal())
    await expect(service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 'bad id!' }, signal()))
      .rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('refuses characters the original encoding cannot map, with position', async () => {
    // Big5 cannot represent Cyrillic; gb18030 maps every code point, so the
    // fixture uses a Big5-prior host for this refusal.
    await writeFile(join(root ?? '.', 'big5.txt'), enc('標題\n', 'big5'))
    const { service, ws, signal } = await harness()
    ;(ctx?.fs as LocalFileSystem).resolvePriors = async () => ({
      localeCharset: 'big5', localeLanguage: 'zh', localeTerritory: 'TW',
    })
    const opened = await service.open(ws, 'big5.txt', signal())
    expect(opened.encoding).toBe('big5')
    const failure = await service.save(ws, 'big5.txt', {
      content: '標題\nemoji 🎉 text\n', baseVersion: opened.version, saveId: 'save-unmap',
    }, signal()).then(() => { throw new Error('expected refusal') }, (error: unknown) => error as RemoteErrorLike)
    expect(failure.code).toBe('unmappable')
    expect(failure.message).toMatch(/line 2 column \d+/u)
    // The unmappable save never publishes bytes.
    expect([...readFileSync(join(root ?? '.', 'big5.txt'))]).toEqual([...enc('標題\n', 'big5')])
  })

  it('refuses content whose encoded size exceeds the editing bound', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'a.txt', signal())
    await expect(service.save(ws, 'a.txt', {
      content: 'a'.repeat(1024 * 1024 + 1), baseVersion: opened.version, saveId: 'save-big',
    }, signal())).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses a save onto a deleted file as not-found', async () => {
    await writeFile(join(root ?? '.', 'gone.txt'), 'x\n')
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'gone.txt', signal())
    await rm(join(root ?? '.', 'gone.txt'))
    await expect(service.save(ws, 'gone.txt', {
      content: 'y\n', baseVersion: opened.version, saveId: 'save-gone',
    }, signal())).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses .git paths and escapes on save like open', async () => {
    const { service, ws, signal } = await harness()
    await expect(service.save(ws, '.git/hooks/pre-commit', {
      content: 'x', baseVersion: 'v', saveId: 's1',
    }, signal())).rejects.toMatchObject({ code: 'git-dir' })
    await expect(service.save(ws, '../outside.txt', {
      content: 'x', baseVersion: 'v', saveId: 's2',
    }, signal())).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it.skipIf(process.platform === 'win32')('preserves the executable mode bit across a save', async () => {
    const { chmodSync } = await import('node:fs')
    await writeFile(join(root ?? '.', 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(root ?? '.', 'run.sh'), 0o755)
    const { service, ws, signal } = await harness()
    const opened = await service.open(ws, 'run.sh', signal())
    await service.save(ws, 'run.sh', {
      content: '#!/bin/sh\necho bye\n', baseVersion: opened.version, saveId: 'save-mode',
    }, signal())
    const { statSync } = await import('node:fs')
    expect(statSync(join(root ?? '.', 'run.sh')).mode & 0o777).toBe(0o755)
  })
})

describe('workspace-file-write agent notice', () => {
  it('injects a path-only notice into matching live sessions after commit', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness({ agentCwds: [root ?? '.', '/elsewhere'] })
    const opened = await service.open(ws, 'a.txt', signal())
    await service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 'save-notice' }, signal())
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toBe(noticeText('a.txt'))
    expect(notices[0]?.source).toMatchObject({ kind: 'plugin', plugin: SOURCE_ID, form: 'system-injection', path: 'a.txt' })
  })

  it('skips foreign cwd values, missing cwd values, and dead cwd paths', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const { service, ws, signal } = await harness({
      agentCwds: [tmpdir(), undefined, '/definitely/not/here'],
    })
    const opened = await service.open(ws, 'a.txt', signal())
    await service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 's1' }, signal())
    expect(notices).toHaveLength(0)
  })

  it('coalesces repeated saves per session and path inside the spacing window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
      const { service, ws, signal } = await harness({ agentCwds: [root ?? '.'] })
      const opened = await service.open(ws, 'a.txt', signal())
      await service.save(ws, 'a.txt', { content: 'y\n', baseVersion: opened.version, saveId: 's1' }, signal())
      const after = await service.stat(ws, 'a.txt', signal())
      if (!('version' in after)) throw new Error('file vanished between saves')
      await service.save(ws, 'a.txt', { content: 'z\n', baseVersion: after.version, saveId: 's2' }, signal())
      expect(notices).toHaveLength(1)
      // Past the window the notice repeats.
      vi.advanceTimersByTime(11_000)
      const again = await service.stat(ws, 'a.txt', signal())
      if (!('version' in again)) throw new Error('file vanished between saves')
      await service.save(ws, 'a.txt', { content: 'w\n', baseVersion: again.version, saveId: 's3' }, signal())
      expect(notices).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds notified sessions and logs a failing inject instead of failing the save', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const cwds = Array.from({ length: 40 }, () => root ?? '.')
    const boom = { id: 'agent-boom', session: { header: { cwd: root } }, inject: () => { throw new Error('inbox closed') } }
    // The failing agent leads: it injects before the cap stops the walk.
    const { service, ws, signal } = await stubOrderHarness({ agentCwds: cwds, extraAgents: [boom] })
    const opened = await service.open(ws, 'a.txt', signal())
    const settled = await service.save(ws, 'a.txt', {
      content: 'y\n', baseVersion: opened.version, saveId: 'bounded',
    }, signal())
    expect(typeof settled.version).toBe('string')
    expect(notices.length).toBeLessThanOrEqual(32)
  })

  it('ignores saved events for workspaces the registry no longer holds', async () => {
    await writeFile(join(root ?? '.', 'a.txt'), 'x\n')
    const harnessResult = await harness({ agentCwds: [root ?? '.'] })
    ctx?.emit('workspace-file/saved', { workspaceId: WorkspaceId('ws-none'), path: 'a.txt', version: 'v', bytes: 1 })
    expect(notices).toHaveLength(0)
    void harnessResult
  })
})
