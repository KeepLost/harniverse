import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const session: ClientSessionContext = { sessionId: 'target' as SessionId }
type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } }

async function sourceOf(
  files: () => Promise<Envelope<FileReferenceCandidate[]>> = () => Promise.resolve({ ok: true, value: [{ path: 'src', kind: 'directory' }, { path: 'docs/a b.md', kind: 'file' }] }),
  sessions: () => Promise<Envelope<SessionReferenceMentionCandidate[]>> = () => Promise.resolve({ ok: true, value: [{ sessionId: 'source' as SessionId, label: 'Research', cwd: '/project', createdAt: 1_700_000_000_000, mention: '@[Research](dsh-session:InNvdXJjZSI)' }] }),
): Promise<InputTriggerSource> {
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource(value: InputTriggerSource) { source = value; return () => { source = undefined } } })
  class Remote extends Service { constructor(owner: Context) { super(owner, 'remote') } }
  new Remote(ctx)
  ctx.provide('remote.fileReferences', { list: files })
  ctx.provide('remote.sessionReferenceResolver', { candidates: sessions })
  await ctx.plugin({ inject: [...inject], apply })
  if (source === undefined) throw new Error('reference source was not registered')
  return source
}

describe('unified reference source', () => {
  it('starts both domains concurrently and orders files before sessions', async () => {
    const source = await sourceOf()
    const candidates = await source.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })
    expect(candidates).toEqual([
      expect.objectContaining({ name: 'Folder · src/', section: 'Files & folders' }),
      expect.objectContaining({ name: 'File · a b.md', section: 'Files & folders' }),
      expect.objectContaining({ name: 'Session · Research', section: 'Session conversations' }),
    ])
  })

  it('suppresses sessions for quoted paths and degrades failed domains independently', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [{ path: 'README.md', kind: 'file' as const }] }))
    const sessions = vi.fn(() => Promise.reject(new Error('session failed')))
    const source = await sourceOf(files, sessions)
    const candidates = await source.candidates(session, { query: 'READ', quoted: true, position: 'inline', signal: new AbortController().signal })
    expect(candidates).toEqual([expect.objectContaining({ name: 'File · README.md' })])
    expect(sessions).not.toHaveBeenCalled()
  })

  it('uses ordinary file text, directory continuation, and canonical session identity', async () => {
    const source = await sourceOf()
    const candidates = await source.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })
    expect(source.onPick({ candidate: candidates[0]!, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })).toEqual({ text: '@src/', continue: true })
    const file = candidates[1]!
    expect(source.onPick({ candidate: file, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })).toEqual({ text: '@"docs/a b.md"' })
    const sessionCandidate = candidates[2]!
    const picked = source.onPick({ candidate: sessionCandidate, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })
    expect(picked).toMatchObject({ insert: { ref: '@[Research](dsh-session:InNvdXJjZSI)', clipboardText: '@[Research](dsh-session:InNvdXJjZSI)' } })
    await expect(source.codec?.serialize('@[Research](dsh-session:InNvdXJjZSI)', new AbortController().signal)).resolves.toBe('@[Research](dsh-session:InNvdXJjZSI)')
  })

  it('ignores foreign candidates without a source-owned payload', async () => {
    const source = await sourceOf()
    expect(source.onPick({ candidate: { name: 'foreign' }, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })).toBeUndefined()
  })

  it('degrades failed domain envelopes to an empty roster', async () => {
    const filesOk = vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'unavailable', message: 'down', details: {} } }))
    const sessionsOk = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const source = await sourceOf(filesOk, sessionsOk)
    await expect(source.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })).resolves.toEqual([])
    const filesRejected = vi.fn(() => Promise.reject(new Error('files failed')))
    const sessionsRejected = vi.fn(() => Promise.reject(new Error('sessions failed')))
    const degraded = await sourceOf(filesRejected, sessionsRejected)
    await expect(degraded.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })).resolves.toEqual([])
    const filesFailing = vi.fn(() => Promise.reject(new Error('files failed')))
    const sessionsFailing = vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'unavailable', message: 'down', details: {} } }))
    const enveloped = await sourceOf(filesFailing, sessionsFailing)
    await expect(enveloped.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })).resolves.toEqual([])
  })

  it('returns no candidates once the request signal has aborted', async () => {
    const source = await sourceOf()
    const controller = new AbortController()
    controller.abort()
    await expect(source.candidates(session, { query: '', position: 'inline', signal: controller.signal })).resolves.toEqual([])
  })

  it('forwards the raw reference text as clipboard text', async () => {
    const source = await sourceOf()
    expect(source.codec?.clipboardText?.('@[Research](dsh-session:InNvdXJjZSI)')).toBe('@[Research](dsh-session:InNvdXJjZSI)')
  })

  it('drops files whose path contains control or quote characters', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [
      { path: 'a"b.md', kind: 'file' as const },
      { path: 'docs/\u0001bad.md', kind: 'file' as const },
    ] }))
    const sessions = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const source = await sourceOf(files, sessions)
    await expect(source.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })).resolves.toEqual([])
  })

  it('quotes an explicitly quoted directory mention and continues the path', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [{ path: 'my src', kind: 'directory' as const }] }))
    const sessions = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const source = await sourceOf(files, sessions)
    const candidates = await source.candidates(session, { query: '', quoted: true, position: 'inline', signal: new AbortController().signal })
    expect(source.onPick({ candidate: candidates[0]!, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })).toEqual({ text: '@"my src/', continue: true })
  })

  it('describes sessions by label alone when it names the id and fills in a missing cwd', async () => {
    const sessions = vi.fn(() => Promise.resolve({ ok: true as const, value: [{ sessionId: 's1' as SessionId, label: 's1', createdAt: 1_700_000_000_000, mention: '@[s1](dsh-session:czE)' }] }))
    const source = await sourceOf(vi.fn(() => Promise.resolve({ ok: true as const, value: [] })), sessions)
    const candidates = await source.candidates(session, { query: '', position: 'inline', signal: new AbortController().signal })
    expect(candidates[0]!.description).toBe('(no cwd) · 2023-11-14T22:13:20.000Z')
  })

  it('ignores picks whose payload is not source-owned JSON', async () => {
    const source = await sourceOf()
    expect(source.onPick({ candidate: { name: 'junk', value: 'not-json' }, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })).toBeUndefined()
  })
})

describe('ui-reference node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the browser-only source appears in the Loader tree.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
