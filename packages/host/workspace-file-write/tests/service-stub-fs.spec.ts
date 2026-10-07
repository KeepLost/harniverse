/**
 * Service arms over a scripted fs seam: the decision-less fallback, the
 * size-less stat fallback, the open retry loop (drift then convergence,
 * and drift to exhaustion), the not-regular refusals, the refusal
 * vocabulary mapping, and the saveId cache bound.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import WorkspaceFileWriteService from '../src/index.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

let root: string | undefined
let ctx: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wfw-stub-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Scripted fs: a queued stat sequence plus a controllable readText. */
function stubFs(options: {
  stats?: Array<FsInfo | undefined>
  reportDecision?: boolean
}) {
  const stats = [...options.stats ?? [{ version: 'v1' as never, type: 'file' as const }]]
  const calls: string[] = []
  return {
    calls,
    writes: [] as string[],
    writeAttempts: 0,
    readError: undefined as unknown,
    writeError: undefined as unknown,
    statError: undefined as unknown,
    statErrorAfterWrites: Number.POSITIVE_INFINITY,
    async resolve(path: string): Promise<FsTarget> {
      return { targetKey: path as never, displayPath: path }
    },
    async stat(): Promise<FsInfo | undefined> {
      calls.push('stat')
      if (this.statError !== undefined && this.writeAttempts >= this.statErrorAfterWrites) throw this.statError
      return stats.length > 1 ? stats.shift() : stats[0]
    },
    async readText(_target: FsTarget, _signal: AbortSignal | undefined, opts?: { onDecision?: (decision: { encoding: string; source: 'explicit' | 'sticky' | 'bom' | 'utf8' | 'host' | 'locale' | 'fallback'; bom: boolean; eol: 'LF' | 'CRLF' }) => void }): Promise<string> {
      calls.push('read')
      if (this.readError !== undefined) throw this.readError
      if (options.reportDecision !== false) {
        opts?.onDecision?.({ encoding: 'utf-8', source: 'utf8', bom: false, eol: 'LF' })
      }
      return 'body\n'
    },
    async writeText(_target: FsTarget, content: string): Promise<{ operation: 'update'; version: string; before: string | null; after: string }> {
      this.writeAttempts += 1
      if (this.writeError !== undefined) throw this.writeError
      this.writes.push(content)
      return { operation: 'update', version: `v${String(this.writes.length + 1)}`, before: null, after: content }
    },
  }
}

async function stubHarness(fs: ReturnType<typeof stubFs>, paths: readonly string[] = ['a.txt']) {
  for (const path of paths) {
    if (path.endsWith('/')) await mkdir(join(root as string, path), { recursive: true })
    else await writeFile(join(root as string, path), 'body\n', 'utf8')
  }
  ctx = new Context()
  ctx.provide('fs', fs as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === 'ws-0' ? { id: 'ws-0', path: realpathSync(root as string) } : undefined),
  })
  await ctx.plugin(WorkspaceFileWriteService)
  return { service: ctx.workspaceFileWrite, ws: WorkspaceId('ws-0'), signal: () => new AbortController().signal }
}

describe('workspace-file-write over a scripted fs', () => {
  it('falls back to a plain UTF-8 decision when the backend reports none', async () => {
    const { service, ws, signal } = await stubHarness(stubFs({ reportDecision: false }))
    const result = await service.open(ws, 'a.txt', signal())
    expect(result.encoding).toBe('utf-8')
    expect(result.encodingSource).toBe('utf8')
    expect(result.bom).toBe(false)
    expect(result.eol).toBe('LF')
  })

  it('derives the byte size from the content when stat carries none', async () => {
    const { service, ws, signal } = await stubHarness(stubFs({ stats: [{ version: 'v1' as never, type: 'file' as const }] }))
    const result = await service.open(ws, 'a.txt', signal())
    expect(result.bytes).toBe('body\n'.length)
  })

  it('retries once when the file drifts between read and re-stat, then converges', async () => {
    const fs = stubFs({
      stats: [
        { version: 'v1' as never, type: 'file' as const },
        { version: 'v2' as never, type: 'file' as const },
        { version: 'v2' as never, type: 'file' as const },
        { version: 'v2' as never, type: 'file' as const },
      ],
    })
    const { service, ws, signal } = await stubHarness(fs)
    const result = await service.open(ws, 'a.txt', signal())
    expect(result.version).toBe('v2')
    expect(fs.calls.filter(call => call === 'read')).toHaveLength(2)
  })

  it('refuses with changed after the retry budget is exhausted', async () => {
    const fs = stubFs({
      stats: [
        { version: 'v1' as never, type: 'file' as const },
        { version: 'v2' as never, type: 'file' as const },
        { version: 'v3' as never, type: 'file' as const },
        { version: 'v4' as never, type: 'file' as const },
        { version: 'v5' as never, type: 'file' as const },
        { version: 'v6' as never, type: 'file' as const },
      ],
    })
    const { service, ws, signal } = await stubHarness(fs)
    await expect(service.open(ws, 'a.txt', signal())).rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses a directory through both open and stat', async () => {
    const directory = { version: 'v1' as never, type: 'directory' as const }
    const openHarness = await stubHarness(stubFs({ stats: [directory] }), ['sub/'])
    await expect(openHarness.service.open(openHarness.ws, 'sub', openHarness.signal()))
      .rejects.toMatchObject({ code: 'not-regular' })
    const statHarness = await stubHarness(stubFs({ stats: [directory] }), ['sub/'])
    await expect(statHarness.service.stat(statHarness.ws, 'sub', statHarness.signal()))
      .rejects.toMatchObject({ code: 'not-regular' })
  })

  it('reports absent through stat when the entry is missing', async () => {
    const gone = await stubHarness(stubFs({ stats: [undefined] }))
    await expect(gone.service.stat(gone.ws, 'gone.txt', gone.signal())).resolves.toEqual({ absent: true })
    // The canonical entry exists but the backend stat reports it gone.
    const present = await stubHarness(stubFs({ stats: [undefined] }))
    await expect(present.service.stat(present.ws, 'a.txt', present.signal())).resolves.toEqual({ absent: true })
  })

  it('refuses open and save when the backend stat loses the file', async () => {
    const openHarness = await stubHarness(stubFs({ stats: [undefined] }))
    await expect(openHarness.service.open(openHarness.ws, 'a.txt', openHarness.signal()))
      .rejects.toMatchObject({ code: 'not-found' })
    const saveHarness = await stubHarness(stubFs({ stats: [undefined] }))
    await expect(saveHarness.service.save(saveHarness.ws, 'a.txt', {
      content: 'x\n', baseVersion: 'v1', saveId: 's',
    }, saveHarness.signal())).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses stat for an unknown workspace', async () => {
    const { service, signal } = await stubHarness(stubFs({}))
    await expect(service.stat(WorkspaceId('ws-x'), 'a.txt', signal())).rejects.toMatchObject({ code: 'workspace-unknown' })
  })

  it('falls back to a UTF-8 decision inside save as well', async () => {
    const { service, ws, signal } = await stubHarness(stubFs({ reportDecision: false }))
    const saved = await service.save(ws, 'a.txt', { content: 'x\n', baseVersion: 'v1', saveId: 's' }, signal())
    expect(saved.version).toMatch(/v/u)
  })

  it('bounds the saveId cache with FIFO eviction', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    let base = 'v0'
    for (let index = 0; index < 130; index++) {
      const saved = await service.save(ws, 'a.txt', { content: `c${String(index)}`, baseVersion: base, saveId: `s${String(index)}` }, signal())
      base = saved.version
    }
    expect(fs.writes).toHaveLength(130)
    // The earliest ids evicted; replaying one writes again.
    await service.save(ws, 'a.txt', { content: 'replay', baseVersion: base, saveId: 's0' }, signal())
    expect(fs.writes).toHaveLength(131)
    // A retained late id still replays without writing.
    await service.save(ws, 'a.txt', { content: 'replay', baseVersion: base, saveId: 's129' }, signal())
    expect(fs.writes).toHaveLength(131)
  })
})

describe('workspace-file-write refusal mapping over a scripted fs', () => {
  it('maps a non-FsError read failure to io with the error message', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.readError = new Error('disk sleep')
    await expect(service.open(ws, 'a.txt', signal())).rejects.toMatchObject({ code: 'io', message: /disk sleep/u })
  })

  it('maps a non-Error read rejection to io with its string form', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.readError = 'plain rejection'
    await expect(service.open(ws, 'a.txt', signal())).rejects.toMatchObject({ code: 'io', message: /plain rejection/u })
  })

  it('maps a read failure inside save through the same refusal vocabulary', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    // The first read belongs to open; arming the error after it fails only save's re-read.
    const opened = await service.open(ws, 'a.txt', signal())
    fs.readError = new Error('short read')
    await expect(service.save(ws, 'a.txt', {
      content: 'x', baseVersion: opened.version, saveId: 's',
    }, signal())).rejects.toMatchObject({ code: 'io', message: /short read/u })
  })

  it('maps a raw write failure to io', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.writeError = new Error('no space left on device')
    await expect(service.save(ws, 'a.txt', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal()))
      .rejects.toMatchObject({ code: 'io', message: /no space left/u })
  })
})

describe('workspace-file-write CAS refusal mapping', () => {
  it('maps a stale CAS with a failing follow-up stat to stale without a version', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.writeError = new FsError('cannot write "a.txt": file changed since it was read', 'FS_STALE_VERSION')
    fs.statError = new Error('stat raced')
    fs.statErrorAfterWrites = 1
    await expect(service.save(ws, 'a.txt', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal()))
      .rejects.toMatchObject({ code: 'stale-version', details: {} })
  })

  it('maps the backend FS_UNMAPPABLE refusal verbatim', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.writeError = new FsError('cannot write "a.txt": 🎉 cannot be encoded', 'FS_UNMAPPABLE')
    await expect(service.save(ws, 'a.txt', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal()))
      .rejects.toMatchObject({ code: 'unmappable', message: /cannot be encoded/u })
  })

  it('maps a non-Error write rejection to io with its string form', async () => {
    const fs = stubFs({})
    const { service, ws, signal } = await stubHarness(fs)
    fs.writeError = 'plain rejection'
    await expect(service.save(ws, 'a.txt', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal()))
      .rejects.toMatchObject({ code: 'io', message: /plain rejection/u })
  })
})
