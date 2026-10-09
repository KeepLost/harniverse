import { describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverOfficialLogs, newestGeneration, resolveSourceId } from '../src/discovery.ts'
import { tempRoot, writeOfficialLog } from './official-fixture.ts'

describe('official generation selection', () => {
  it('picks the numerically newest generation and prefers the compressed spelling of a tie', () => {
    expect(newestGeneration(['session.v3.jsonl.zstd', 'session.v10.jsonl', 'session.v9.jsonl.zstd'])).toBe('session.v10.jsonl')
    expect(newestGeneration(['session.v4.jsonl.zstd', 'session.v4.jsonl'])).toBe('session.v4.jsonl.zstd')
    expect(newestGeneration(['session.v4.jsonl', 'session.v4.jsonl.zstd'])).toBe('session.v4.jsonl.zstd')
  })

  it('ignores native logs, retained sources, and look-alikes', () => {
    expect(newestGeneration(['session.jsonl.zstd', 'session.v0.jsonl', 'session.v4.jsonl.gz', 'a.source.jsonl', 'session.lock'])).toBeUndefined()
  })
})

describe('official log discovery', () => {
  it('lists the newest generation of every session directory under every root', async () => {
    const first = await tempRoot('dsh-official-a-')
    const second = await tempRoot('dsh-official-b-')
    try {
      await writeOfficialLog(first, '--home-a--', 's1', 'session.v3.jsonl.zstd', 'x')
      await writeOfficialLog(first, '--home-a--', 's1', 'session.v4.jsonl.zstd', 'x')
      await writeOfficialLog(first, '_no-cwd', 's2', 'session.v2.jsonl', 'x')
      await writeOfficialLog(first, '--home-a--', 'native', 'session.jsonl.zstd', 'x')
      await writeFile(join(first, 'stray-file'), 'x')
      await writeOfficialLog(second, '--home-b--', 's3', 'session.v1.jsonl', 'x')
      const missing = join(first, 'does-not-exist')
      const discovery = await discoverOfficialLogs([first, missing, second])
      expect(discovery.failures).toEqual([])
      expect(discovery.logs).toEqual([
        { sourceId: '0/--home-a--/s1/session.v4.jsonl.zstd', path: join(first, '--home-a--', 's1', 'session.v4.jsonl.zstd') },
        { sourceId: '0/_no-cwd/s2/session.v2.jsonl', path: join(first, '_no-cwd', 's2', 'session.v2.jsonl') },
        { sourceId: '2/--home-b--/s3/session.v1.jsonl', path: join(second, '--home-b--', 's3', 'session.v1.jsonl') },
      ])
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('reports a root that exists but cannot be listed', async () => {
    const root = await tempRoot('dsh-official-file-')
    try {
      const file = join(root, 'not-a-directory')
      await writeFile(file, 'x')
      const discovery = await discoverOfficialLogs([file])
      expect(discovery.logs).toEqual([])
      expect(discovery.failures).toEqual([{ path: file, message: expect.stringContaining('ENOTDIR') as string }])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('stops between directories once aborted', async () => {
    const root = await tempRoot('dsh-official-abort-')
    try {
      await mkdir(join(root, 'p', 's'), { recursive: true })
      const abort = new AbortController()
      abort.abort(new Error('stop'))
      await expect(discoverOfficialLogs([root], abort.signal)).rejects.toThrow('stop')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('source id resolution', () => {
  const roots = ['/data/one', '/data/two']

  it('maps a well-formed id under its root', () => {
    expect(resolveSourceId(roots, '1/--p--/s/session.v4.jsonl.zstd')).toBe(join('/data/two', '--p--', 's', 'session.v4.jsonl.zstd'))
  })

  it.each([
    '', 'x/p/s/session.v4.jsonl', '01/p/s/session.v4.jsonl', '2/p/s/session.v4.jsonl',
    '0/p/session.v4.jsonl', '0/p/s/x/session.v4.jsonl', '0/../s/session.v4.jsonl', '0/./s/session.v4.jsonl',
    '0//s/session.v4.jsonl', '0/p\\q/s/session.v4.jsonl', '0/C:/s/session.v4.jsonl', '0/p/s/notes.txt',
  ])('refuses %j', (sourceId) => {
    expect(resolveSourceId(roots, sourceId)).toBeUndefined()
  })
})
