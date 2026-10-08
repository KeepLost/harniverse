/** Turn rendering: streamed edits, final text per end reason, failure fallbacks, and file delivery. */

import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { vi } from 'vitest'
import { boot, cleanup, member, REMOTE, type Harness } from './helpers.ts'
import { begin, delta, finish } from './turn.ts'

afterEach(cleanup)

describe('streamed reply', () => {
  it('sends a placeholder, edits in place as text and tools arrive, and ends with the complete text', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    expect(h.adapter.transcript.map(entry => entry.kind).slice(0, 2)).toEqual(['typing', 'send'])
    const placeholder = h.adapter.transcript.find(entry => entry.kind === 'send')
    expect(placeholder).toMatchObject({ kind: 'send', message: { text: '...' }, route: { kind: 'direct', chatId: '200' } })
    await turn.next('assistant/chunk', delta('Hel'))
    await turn.next('assistant/chunk', delta('lo'))
    await turn.next('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    await import('vitest').then(({ vi }) => vi.waitFor(() => { expect(h.sent().at(-1)).toBe('Hello\n\n[tool: bash]') }))
    await turn.next('tool/result', { turn: 1, step: 1, callId: 'c1' })
    await turn.next('step/start', { turn: 1, step: 2 })
    await turn.next('assistant/chunk', delta('World'))
    await turn.next('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'reasoning-delta', text: 'hidden' } })
    await finish(turn)
    expect(h.sent().at(-1)).toBe('Hello\n\nWorld')
    expect(h.sent().join('\n')).not.toContain('hidden')
    const edits = h.adapter.transcript.filter(entry => entry.kind === 'edit')
    expect(edits.length).toBeGreaterThan(0)
    expect(new Set(edits.map(entry => entry.ref.messageId)).size).toBe(1)
  })

  it('shows a tool line before any text and nothing when the tool result returns to an empty turn', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    await turn.next('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
    await import('vitest').then(({ vi }) => vi.waitFor(() => { expect(h.sent().at(-1)).toBe('[tool: read]') }))
    await turn.next('tool/result', { turn: 1, step: 1, callId: 'c1' })
    await finish(turn)
    expect(h.sent().at(-1)).toBe('(no text reply)')
  })

  it('delivers only the final text on a platform that cannot edit', async () => {
    const h = await boot({ config: { members: [member()] }, capabilities: { editOutbound: false } })
    const turn = await begin(h)
    await turn.next('assistant/chunk', delta('Done'))
    await finish(turn)
    expect(h.adapter.transcript.filter(entry => entry.kind === 'send').map(entry => entry.kind === 'send' && entry.message.text)).toEqual(['Done'])
    expect(h.adapter.transcript.some(entry => entry.kind === 'edit')).toBe(false)
  })

  it('splits text beyond the platform limit into following messages', async () => {
    const h = await boot({ config: { members: [member()] }, capabilities: { maxTextLength: 20 } })
    const turn = await begin(h)
    await turn.next('assistant/chunk', delta('alpha beta gamma delta epsilon zeta eta theta'))
    await finish(turn)
    const sends = h.adapter.transcript.filter(entry => entry.kind === 'send')
    expect(sends.length).toBeGreaterThan(2)
    expect(sends.slice(1).map(entry => entry.kind === 'send' && entry.message.text).join(' ')).toContain('zeta')
    for (const text of h.sent().slice(1)) expect(text.length).toBeLessThanOrEqual(20)
  })

  it.each([
    [{ kind: 'completed' }, '', '(no text reply)'],
    [{ kind: 'aborted' }, 'partial', 'partial\n\n[stopped]'],
    [{ kind: 'aborted' }, '', '[stopped]'],
    [{ kind: 'blocked' }, 'x', 'x\n\n[blocked]'],
    [{ kind: 'interrupted' }, 'x', 'x\n\n[interrupted]'],
    [{ kind: 'max-tokens' }, 'long answer', 'long answer\n\n[output limit reached]'],
    [{ kind: 'error', error: { message: 'model exploded' } }, 'x', 'x\n\n[error] model exploded'],
    [{ kind: 'error', error: {} }, '', '[error] the turn failed'],
    [{ kind: 'something-new' }, 'x', 'x\n\n[ended]'],
    ['not an object', '', '[ended]'],
  ])('ends a turn with reason %j and text %j as %j', async (reason, text, expected) => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    if (text !== '') await turn.next('assistant/chunk', delta(text))
    await finish(turn, reason as Record<string, unknown>)
    expect(h.sent().at(-1)).toBe(expected)
  })
})

describe('delivery failures', () => {
  it('falls back to a new message when an edit fails and keeps editing that one', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    h.adapter.failNext('edit', new ChatAdapterError('edit-failed', 'fake', 'gone'))
    await turn.next('assistant/chunk', delta('one'))
    await import('vitest').then(({ vi }) => vi.waitFor(() => { expect(h.adapter.transcript.filter(entry => entry.kind === 'send')).toHaveLength(2) }))
    await turn.next('assistant/chunk', delta(' two'))
    await finish(turn)
    const sends = h.adapter.transcript.filter(entry => entry.kind === 'send')
    expect(sends.map(entry => entry.kind === 'send' && entry.message.text)).toEqual(['...', 'one'])
    expect(h.adapter.transcript.at(-1)).toMatchObject({ kind: 'edit', ref: sends[1]!.ref, message: { text: 'one two' } })
  })

  it('pauses edits after a rate limit and retries with the same text', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    h.adapter.failNext('edit', new ChatAdapterError('rate-limited', 'fake', 'slow', { retryAfterMs: 40 }))
    await turn.next('assistant/chunk', delta('text'))
    await import('vitest').then(({ vi }) => vi.waitFor(() => { expect(h.sent().at(-1)).toBe('text') }, { timeout: 2_000 }))
    await finish(turn)
    expect(h.sent().at(-1)).toBe('text')
  })

  it('retries a rate-limited edit without a retry hint immediately', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    h.adapter.failNext('edit', new ChatAdapterError('rate-limited', 'fake', 'slow'))
    await turn.next('assistant/chunk', delta('again'))
    await import('vitest').then(({ vi }) => vi.waitFor(() => { expect(h.sent().at(-1)).toBe('again') }))
    await finish(turn)
  })

  it('logs and skips an edit that fails for another reason', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    h.adapter.failNext('edit', new Error('network down'))
    await turn.next('assistant/chunk', delta('lost'))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('streamed message update failed') })
    await turn.next('assistant/chunk', delta(' kept'))
    await finish(turn)
    expect(h.sent().at(-1)).toBe('lost kept')
  })

  it('sends the final text as a new message when the placeholder could not be created', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', 'warm up')
    h.adapter.failNext('send', new ChatAdapterError('send-failed', 'fake', 'nope'))
    await h.say('200', 'question')
    const sessionId = String(h.client.of('session.create').at(-1)?.payload.sessionId)
    const rpcId = String(h.client.of('session.prompt').at(-1)?.options.rpcId)
    const mux = h.client.mux()
    await mux.event(sessionId, 0, 'turn/start', { turn: 1 })
    await mux.event(sessionId, 1, 'user/message', { source: { rpcId } })
    await mux.event(sessionId, 2, 'assistant/chunk', delta('answer'))
    await mux.event(sessionId, 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.sent().at(-1)).toBe('answer')
  })

  it('sends the final text as a new message when finishing the edit fails', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    await turn.next('assistant/chunk', delta('result'))
    h.adapter.failNext('edit', new Error('edit broke'))
    await finish(turn)
    expect(h.adapter.transcript.at(-1)).toMatchObject({ kind: 'send', message: { text: 'result' } })
  })

  it('tells the user once when a final reply cannot be sent', async () => {
    const h = await boot({ config: { members: [member()] }, capabilities: { editOutbound: false } })
    const turn = await begin(h)
    h.adapter.failNext('send', new ChatAdapterError('send-failed', 'fake', 'nope'))
    await finish(turn)
    expect(h.sent().at(-1)).toBe('Sending failed, try again later.')
  })

  it('waits out a platform rate limit once when replying', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.adapter.failNext('send', new ChatAdapterError('rate-limited', 'fake', 'slow', { retryAfterMs: 5 }))
    await h.say('200', '/whoami')
    expect(h.sent()[0]).toContain('fake:200 - member alice')
    h.adapter.failNext('send', new ChatAdapterError('rate-limited', 'fake', 'slow'))
    await h.say('200', '/whoami')
    expect(h.sent()).toHaveLength(2)
  })

  it('gives up quietly when even the failure notice cannot be sent', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.adapter.failNext('send', new ChatAdapterError('send-failed', 'fake', 'nope'))
    h.adapter.failNext('send', new ChatAdapterError('send-failed', 'fake', 'nope'))
    await h.say('200', '/whoami')
    expect(h.adapter.transcript).toHaveLength(0)
  })

  it('stops splitting a reply after a chunk fails', async () => {
    const h = await boot({ config: { members: [member()] }, capabilities: { maxTextLength: 10 } })
    h.adapter.failNext('send', new Error('boom'))
    await h.say('100', '/help')
    expect(h.sent()).toEqual(['Sending failed, try again later.'])
  })
})

describe('claims', () => {
  it('ignores a second prompt claimed into the same turn and survives a failing typing hint', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.adapter.failNext('typing', new Error('typing down'))
    const turn = await begin(h)
    await h.say('200', 'second')
    const second = String(h.client.of('session.prompt').at(-1)?.options.rpcId)
    const before = h.adapter.transcript.length
    await turn.next('user/message', { source: { rpcId: second } })
    expect(h.adapter.transcript).toHaveLength(before)
    await turn.next('assistant/chunk', delta('one reply'))
    await finish(turn)
    expect(h.sent().at(-1)).toBe('one reply')
  })

  it('renders nothing when the originating adapter left the registry before the claim', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', 'question')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    const rpcId = String(h.client.of('session.prompt')[0]?.options.rpcId)
    h.unregister()
    const before = h.adapter.transcript.length
    await h.client.mux().event(sessionId, 0, 'turn/start', { turn: 1 })
    await h.client.mux().event(sessionId, 1, 'user/message', { source: { rpcId } })
    await h.client.mux().event(sessionId, 2, 'assistant/chunk', delta('nobody listens'))
    await h.client.mux().event(sessionId, 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.adapter.transcript).toHaveLength(before)
  })
})

describe('turns the bridge did not start', () => {
  it('renders nothing for a turn without an IM prompt or an unknown prompt', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/new')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    const mux = h.client.mux()
    await mux.event(sessionId, 0, 'turn/start', { turn: 1 })
    await mux.event(sessionId, 1, 'user/message', { source: { kind: 'user', rpcId: 'from-the-web' } })
    await mux.event(sessionId, 2, 'user/message', { source: {} })
    await mux.event(sessionId, 3, 'assistant/chunk', delta('web answer'))
    await mux.event(sessionId, 4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await mux.event('not-ours', 0, 'turn/start', { turn: 1 })
    expect(h.sent()).toHaveLength(1)
  })

  it('ignores replayed sequence numbers and events outside a turn', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    await turn.mux.event(turn.sessionId, 0, 'assistant/chunk', delta('ghost'))
    await turn.mux.event(turn.sessionId, 50, 'assistant/chunk', { chunk: 'not an object' })
    await turn.mux.event(turn.sessionId, 51, 'assistant/chunk', delta('real'))
    turn.seq = 52
    await finish(turn)
    expect(h.sent().at(-1)).toBe('real')
    await turn.mux.event(turn.sessionId, 60, 'assistant/chunk', delta('late'))
    await turn.mux.event(turn.sessionId, 61, 'step/start', { turn: 2, step: 1 })
    await turn.mux.event(turn.sessionId, 62, 'tool/call', { callId: 'x', name: 'n', arguments: '{}' })
    await turn.mux.event(turn.sessionId, 63, 'tool/result', { callId: 'x' })
    await turn.mux.event(turn.sessionId, 64, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    await turn.mux.event(turn.sessionId, 65, 'user/message', { source: { rpcId: 'late' } })
    await turn.mux.event(turn.sessionId, 66, 'session/title', { title: 'x' })
    expect(h.sent().at(-1)).toBe('real')
  })

  it('renders nothing when the originating adapter is gone', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    const unregister = h.ctx.chatAdapters.list()
    expect(unregister).toHaveLength(1)
    await h.ctx.fiber.dispose()
    expect(turn.sessionId).toMatch(/^chat-/)
  })
})

describe('file delivery', () => {
  async function workspace(h: Harness): Promise<string> {
    const dir = join(h.root, 'im', 'members', 'alice')
    await mkdir(dir, { recursive: true })
    return dir
  }

  it('sends presented files that stay inside the session workspace and explains the rest', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    const dir = await workspace(h)
    await writeFile(join(dir, 'report.txt'), 'hello')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'deep.txt'), 'deep')
    await writeFile(join(h.root, 'outside.txt'), 'secret')
    await symlink(join(h.root, 'outside.txt'), join(dir, 'link.txt'))
    await symlink(h.root, join(dir, 'linkdir'))
    await turn.next('deliverables/presented', { turn: 1, callId: 'c', files: [
      { path: 'report.txt' }, { path: join(dir, 'sub', 'deep.txt') }, { path: join(h.root, 'outside.txt') }, { path: '../../../outside.txt' },
      { path: 'link.txt' }, { path: 'linkdir/outside.txt' }, { path: 'missing.txt' }, { path: 'sub' },
    ] })
    const files = h.adapter.transcript.filter(entry => entry.kind === 'file')
    expect(files.map(entry => entry.kind === 'file' && entry.file.fileName)).toEqual(['report.txt', 'deep.txt'])
    expect(files[0]).toMatchObject({ file: { bytes: 5 }, route: { kind: 'direct', chatId: '200' } })
    expect(h.sent().slice(-6)).toEqual([
      'Not sending "outside.txt": file is outside the session workspace.',
      'Not sending "outside.txt": file is outside the session workspace.',
      'Not sending "link.txt": symbolic links are not delivered.',
      'Not sending "outside.txt": file is outside the session workspace.',
      'Not sending "missing.txt": file not found.',
      'Not sending "sub": not a regular file.',
    ])
    expect(h.sent().join('\n')).not.toContain(h.root)
  })

  it('refuses files above the size cap and reports a platform refusal', async () => {
    const h = await boot({ config: { members: [member()], outbound: { maxFileBytes: 10 } } })
    const turn = await begin(h)
    const dir = await workspace(h)
    await writeFile(join(dir, 'big.bin'), new Uint8Array(11))
    await writeFile(join(dir, 'ok.bin'), new Uint8Array(4))
    await writeFile(join(dir, 'ok2.bin'), new Uint8Array(4))
    await turn.next('deliverables/presented', { files: [{ path: 'big.bin' }] })
    expect(h.sent().at(-1)).toBe('Not sending "big.bin": file is larger than 10 bytes.')
    h.adapter.failNext('file', new ChatAdapterError('file-too-large', 'fake', 'too big'))
    await turn.next('deliverables/presented', { files: [{ path: 'ok.bin' }] })
    expect(h.sent().at(-1)).toBe('ok.bin is larger than this platform accepts.')
    h.adapter.failNext('file', new Error('upload died'))
    await turn.next('deliverables/presented', { files: [{ path: 'ok2.bin' }] })
    expect(h.sent().at(-1)).toBe('Sending ok2.bin failed.')
  })

  it('does not deliver files on platforms without file support or from remote hosts', async () => {
    const plain = await boot({ config: { members: [member()] }, capabilities: { outboundFiles: false } })
    const plainTurn = await begin(plain)
    await plainTurn.next('deliverables/presented', { files: [{ path: 'a.txt' }] })
    expect(plain.sent().at(-1)).toBe('This platform cannot receive files.')
    const remote = await boot({ config: { members: [member({ dshRemoteHost: REMOTE })] } })
    const remoteTurn = await begin(remote)
    await remoteTurn.next('deliverables/presented', { files: [{ path: 'a.txt' }] })
    expect(remote.sent().at(-1)).toBe('Files from a remote host are not delivered to chat.')
  })

  it('delivers to the session chat when files are presented outside a chat-started turn', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/new')
    const dir = await workspace(h)
    await writeFile(join(dir, 'late.txt'), 'x')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    await h.client.mux().event(sessionId, 0, 'deliverables/presented', { files: [{ path: 'late.txt' }] })
    expect(h.adapter.transcript.at(-1)).toMatchObject({ kind: 'file', route: { kind: 'direct', chatId: '200' } })
    await h.client.mux().event(sessionId, 1, 'deliverables/presented', { files: 'not a list' })
  })

  it('threads keep their route', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('100', '/pair-group', { kind: 'group', threadId: 't1' })
    await h.say('200', 'hello', { kind: 'group', threadId: 't1' })
    const dir = await workspace(h)
    await writeFile(join(dir, 'f.txt'), 'x')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    await h.client.mux().event(sessionId, 0, 'deliverables/presented', { files: [{ path: 'f.txt' }] })
    expect(h.adapter.transcript.at(-1)).toMatchObject({ kind: 'file', route: { kind: 'group', chatId: 'group-1', threadId: 't1' } })
  })
})
