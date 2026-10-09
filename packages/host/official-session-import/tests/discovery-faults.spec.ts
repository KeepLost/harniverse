import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: vi.fn((path: string, options?: unknown) => path.endsWith('broken')
      ? Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
      : path.endsWith('odd')
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
        ? Promise.reject('not an error')
        : actual.readdir(path, options as never)),
  }
})

const { discoverOfficialLogs } = await import('../src/discovery.ts')
const { tempRoot, writeOfficialLog } = await import('./official-fixture.ts')
const { rm, mkdir } = await import('node:fs/promises')

describe('official log discovery faults', () => {
  it('reports unlistable session directories and keeps the rest', async () => {
    const root = await tempRoot('dsh-official-faults-')
    try {
      await writeOfficialLog(root, 'p', 'good', 'session.v4.jsonl', 'x')
      await mkdir(join(root, 'p', 'broken'))
      await mkdir(join(root, 'p', 'odd'))
      const discovery = await discoverOfficialLogs([root])
      expect(discovery.logs.map(log => log.sourceId)).toEqual(['0/p/good/session.v4.jsonl'])
      expect(discovery.failures).toEqual([
        { path: join(root, 'p', 'broken'), message: 'EIO: i/o error' },
        { path: join(root, 'p', 'odd'), message: 'not an error' },
      ])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reports an unlistable project directory', async () => {
    const root = await tempRoot('dsh-official-faults-')
    try {
      await mkdir(join(root, 'broken'))
      await mkdir(join(root, 'odd'))
      const discovery = await discoverOfficialLogs([root])
      expect(discovery.failures).toEqual([
        { path: join(root, 'broken'), message: 'EIO: i/o error' },
        { path: join(root, 'odd'), message: 'not an error' },
      ])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
