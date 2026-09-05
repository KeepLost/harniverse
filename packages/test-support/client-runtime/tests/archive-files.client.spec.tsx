// @vitest-environment jsdom
/**
 * Archive and file-surface behavior of the client test doubles: the
 * TestWorkspaces file/git verb defaults and stubs, archive-set mutation, and
 * the TestSessions archive verbs over real fixture sessions.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

afterEach(cleanup)

const wid = (value: string) => value as WorkspaceId
const sid = (value: string) => value as SessionId

describe('TestWorkspaces file and git verbs', () => {
  it('echoes inert defaults while recording every argument including the signal', async () => {
    const runtime = await SlotTestRuntime.create()
    const controller = new AbortController()
    const workspaces = runtime.workspaces

    await expect(workspaces.listFiles(wid('ws'), 'src', controller.signal)).resolves.toEqual({
      path: 'src', entries: [], truncated: false,
    })
    await expect(workspaces.listFiles(wid('ws'))).resolves.toEqual({ path: '', entries: [], truncated: false })
    await expect(workspaces.readFile(wid('ws'), 'a.ts', controller.signal)).resolves.toEqual({
      path: 'a.ts', content: '', bytes: 0, truncated: false,
    })
    await expect(workspaces.searchFiles(wid('ws'), 'query', { include: ['*.ts'], exclude: [] }, controller.signal)).resolves.toEqual({
      entries: [], truncated: false,
    })
    await expect(workspaces.readBinaryFile(wid('ws'), 'p.png', controller.signal)).resolves.toEqual({
      path: 'p.png', dataBase64: '', mediaType: 'image/png', bytes: 0,
    })
    await expect(workspaces.gitStatus(wid('ws'), controller.signal)).resolves.toEqual({
      branch: null, entries: [], truncated: false,
    })
    await expect(workspaces.gitCommits(wid('ws'), 5, controller.signal)).resolves.toEqual({
      commits: [], truncated: false,
    })
    await expect(workspaces.gitDiff(wid('ws'), 'a.ts', true, controller.signal)).resolves.toEqual({
      diff: '', truncated: false,
    })

    expect(workspaces.calls).toEqual([
      { method: 'listFiles', args: [wid('ws'), 'src', controller.signal] },
      { method: 'listFiles', args: [wid('ws'), undefined, undefined] },
      { method: 'readFile', args: [wid('ws'), 'a.ts', controller.signal] },
      { method: 'searchFiles', args: [wid('ws'), 'query', { include: ['*.ts'], exclude: [] }, controller.signal] },
      { method: 'readBinaryFile', args: [wid('ws'), 'p.png', controller.signal] },
      { method: 'gitStatus', args: [wid('ws'), controller.signal] },
      { method: 'gitCommits', args: [wid('ws'), 5, controller.signal] },
      { method: 'gitDiff', args: [wid('ws'), 'a.ts', true, controller.signal] },
    ])
  })

  it('serves stubbed results with the recorded arguments forwarded', async () => {
    const runtime = await SlotTestRuntime.create()
    const workspaces = runtime.workspaces
    const controller = new AbortController()
    const file = { name: 'a.ts', path: 'src/a.ts', kind: 'file' as const }
    workspaces.stub('listFiles', (_workspaceId: unknown, path: unknown, signal: unknown) => {
      expect(signal).toBe(controller.signal)
      return Promise.resolve({ path: path as string, entries: [file], truncated: true })
    })
    workspaces.stub('readFile', (_workspaceId: unknown, path: unknown) => (
      Promise.resolve({ path: path as string, content: 'body', bytes: 4, truncated: false })
    ))
    workspaces.stub('searchFiles', () => Promise.resolve({ entries: [file], truncated: false }))
    workspaces.stub('readBinaryFile', (_workspaceId: unknown, path: unknown) => (
      Promise.resolve({ path: path as string, dataBase64: 'AA==', mediaType: 'image/png', bytes: 1 })
    ))
    workspaces.stub('gitStatus', () => Promise.resolve({ branch: 'dev', entries: [], truncated: false }))
    workspaces.stub('gitCommits', (_workspaceId: unknown, limit: unknown) => (
      Promise.resolve({ commits: [{ hash: 'h', shortHash: 'h', authorName: 'a', authorEmail: 'e', authoredAt: 't', subject: 's' }], truncated: limit === 1 })
    ))
    workspaces.stub('gitDiff', (_workspaceId: unknown, path: unknown, staged: unknown) => (
      Promise.resolve({ diff: `${String(path)}:${String(staged)}`, truncated: false })
    ))

    await expect(workspaces.listFiles(wid('ws'), 'src', controller.signal)).resolves.toEqual({
      path: 'src', entries: [file], truncated: true,
    })
    await expect(workspaces.readFile(wid('ws'), 'src/a.ts')).resolves.toEqual({
      path: 'src/a.ts', content: 'body', bytes: 4, truncated: false,
    })
    await expect(workspaces.searchFiles(wid('ws'), 'a')).resolves.toEqual({ entries: [file], truncated: false })
    await expect(workspaces.readBinaryFile(wid('ws'), 'p.png')).resolves.toEqual({
      path: 'p.png', dataBase64: 'AA==', mediaType: 'image/png', bytes: 1,
    })
    await expect(workspaces.gitStatus(wid('ws'))).resolves.toEqual({ branch: 'dev', entries: [], truncated: false })
    await expect(workspaces.gitCommits(wid('ws'), 1)).resolves.toEqual({
      commits: [{ hash: 'h', shortHash: 'h', authorName: 'a', authorEmail: 'e', authoredAt: 't', subject: 's' }], truncated: true,
    })
    await expect(workspaces.gitDiff(wid('ws'), 'a.ts', true)).resolves.toEqual({ diff: 'a.ts:true', truncated: false })
    expect(workspaces.calls.map(call => call.method)).toEqual([
      'listFiles', 'readFile', 'searchFiles', 'readBinaryFile', 'gitStatus', 'gitCommits', 'gitDiff',
    ])
  })

  it('removes an archived session id by default and leaves the set untouched when stubbed', async () => {
    const runtime = await SlotTestRuntime.create()
    const workspaces = runtime.workspaces
    await workspaces.update((draft) => {
      draft.archivedSessionIds = [sid('a'), sid('b')]
    })

    await workspaces.unarchiveSession(sid('a'))
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([sid('b')])
    expect(workspaces.calls).toEqual([{ method: 'unarchiveSession', args: [sid('a')] }])

    workspaces.stub('unarchiveSession', () => Promise.resolve())
    await workspaces.unarchiveSession(sid('b'))
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([sid('b')])
    expect(workspaces.calls).toEqual([
      { method: 'unarchiveSession', args: [sid('a')] },
      { method: 'unarchiveSession', args: [sid('b')] },
    ])
  })
})

describe('TestSessions archive verbs', () => {
  it('serves fixture snapshots for archive reads and echoes deletion', async () => {
    const runtime = await SlotTestRuntime.create()
    const sessions = runtime.sessions
    await sessions.add({ id: 's1' }, { current: false })
    await sessions.add({ id: 's2' })

    const opened = await sessions.openArchive(sid('s1'))
    expect(opened).toMatchObject({ ok: true })
    if (opened.ok) expect(opened.value.snapshot.sessionId).toBe(sid('s1'))

    const older = await sessions.loadArchiveOlder(sid('s2'))
    expect(older).toMatchObject({ ok: true })
    if (older.ok) expect(older.value.snapshot.sessionId).toBe(sid('s2'))

    await expect(sessions.deleteSession(sid('s1'))).resolves.toEqual({
      ok: true, value: { deleted: true, attachmentsRetained: true },
    })
    expect(sessions.calls).toEqual([
      { method: 'openArchive', args: [sid('s1')] },
      { method: 'loadArchiveOlder', args: [sid('s2')] },
      { method: 'deleteSession', args: [sid('s1')] },
    ])

    expect(() => { void sessions.openArchive(sid('ghost')) }).toThrow('test session "ghost" is not added')
    expect(() => { void sessions.loadArchiveOlder(sid('ghost')) }).toThrow('test session "ghost" is not added')
  })
})
