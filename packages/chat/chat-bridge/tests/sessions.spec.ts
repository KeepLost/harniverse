/** Sessions, workspaces, isolation options, and the session-scoped commands. */

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarniverseError } from '@deepseek-ai/dsh-chat-harniverse-client'
import { boot, cleanup, member, message, REMOTE, seedState, type Harness } from './helpers.ts'

afterEach(cleanup)

const ALIASES = { proj: '/srv/proj', docs: '/srv/docs' }

function sessionId(h: Harness, index = -1): string {
  return String(h.client.of('session.create').at(index)?.payload.sessionId)
}

/** Put the bound session into a running turn started by the prompt with `rpcId`. */
async function run(h: Harness, rpcId: string, remote?: string): Promise<void> {
  const mux = h.client.mux(remote)
  const id = sessionId(h)
  await mux.event(id, 1, 'turn/start', { turn: 1 })
  await mux.event(id, 2, 'user/message', { id: 'inbox-x', source: { kind: 'user', rpcId } })
}

function lastRpc(h: Harness): string {
  return String(h.client.of('session.prompt').at(-1)?.options.rpcId)
}

describe('session creation', () => {
  it('persists the session before creating it, then prompts and reuses it', async () => {
    const h = await boot({ config: { members: [member({ agentProfile: 'chat-code' })] } })
    let persistedFirst: boolean | undefined
    h.client.on('session.create', (payload) => {
      persistedFirst = h.state().table('sessions').get(String(payload.sessionId)) !== undefined
        && h.state().table('bindings').get('fake-bot:direct:200')?.sessionId === payload.sessionId
      return { sessionId: payload.sessionId }
    })
    await h.say('200', 'first question')
    await h.say('200', 'second question')
    expect(persistedFirst).toBe(true)
    expect(h.client.of('session.create')).toHaveLength(1)
    const create = h.client.of('session.create')[0]!
    expect(create.payload).toMatchObject({ agentProfile: 'chat-code', cwd: join(h.root, 'im', 'members', 'alice') })
    expect(String(create.payload.sessionId)).toMatch(/^chat-[0-9a-f-]{36}$/)
    const prompts = h.client.of('session.prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.payload).toEqual({ sessionId: create.payload.sessionId, mode: 'queue', content: [{ type: 'text', text: 'first question' }] })
    expect(prompts[0]?.options.rpcId).toEqual(expect.any(String))
    expect(prompts[0]?.options.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
    expect(h.state().table('sessions').get(sessionId(h))).toMatchObject({ ownerKey: 'fake:200', platform: 'fake' })
  })

  it('starts owner sessions under the IM root with the owner profile', async () => {
    const h = await boot({ config: { owners: [{ platform: 'fake', userId: '100', agentProfile: 'owner-profile', workspaces: ['proj'] }], workspaceAliases: ALIASES } })
    await h.say('100', '/new')
    expect(h.client.of('session.create')[0]?.payload).toMatchObject({ cwd: '/srv/proj', agentProfile: 'owner-profile' })
    expect(h.sent()[0]).toMatch(/^Started a new session \(\.\.\.[0-9a-f]{8}\)\.$/)
  })

  it('uses the IM root for an owner without workspaces and a paired owner', async () => {
    const h = await boot({ owners: [] })
    await h.state().table('members').put('fake:500', { role: 'owner', pairedAt: 1 })
    await h.say('500', 'hello')
    expect(h.client.of('session.create')[0]?.payload).toMatchObject({ cwd: join(h.root, 'im', 'owner') })
    expect(h.client.of('session.create')[0]?.payload).not.toHaveProperty('agentProfile')
  })

  it('creates a fresh session on /new, rejecting a foreign profile', async () => {
    const h = await boot({ config: { members: [member({ agentProfile: 'chat-code' })] } })
    await h.say('200', '/new other')
    expect(h.sent()).toEqual(['That profile is not available to you.'])
    await h.say('200', '/new chat-code')
    await h.say('200', '/new')
    expect(h.client.of('session.create')).toHaveLength(2)
    expect(h.state().table('sessions').size).toBe(2)
    expect(h.state().table('bindings').get('fake-bot:direct:200')?.sessionId).toBe(sessionId(h))
  })

  it('rolls the records back when session.create fails', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.client.on('session.create', () => { throw new HarniverseError('transport-failed', 'down') })
    await h.say('200', 'hello')
    expect(h.sent()).toEqual(['The assistant service is unavailable right now.'])
    expect(h.state().table('sessions').size).toBe(0)
    expect(h.state().table('bindings').size).toBe(0)
    await h.say('200', '/ws')
    h.client.on('session.create', payload => ({ sessionId: payload.sessionId }))
    await h.say('200', '/new')
    await h.state().table('bindings').put('fake-bot:direct:200', { sessionId: 'gone', workspace: 'proj' })
    h.client.on('session.create', () => { throw new HarniverseError('transport-failed', 'down') })
    await h.say('200', '/new')
    expect(h.state().table('bindings').get('fake-bot:direct:200')).toEqual({ sessionId: 'gone', workspace: 'proj' })
  })

  it('maps rejected and unexpected failures to short user messages', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.client.on('session.prompt', () => { throw new HarniverseError('rpc-rejected', 'x', { rpcCode: 'session-not-found' }) })
    await h.say('200', 'one')
    h.client.on('session.prompt', () => { throw new HarniverseError('rpc-rejected', 'x', { rpcCode: 'model-unavailable' }) })
    await h.say('200', 'two')
    h.client.on('session.prompt', () => { throw new HarniverseError('protocol-violation', 'x') })
    await h.say('200', 'three')
    h.client.on('session.prompt', () => { throw new HarniverseError('authentication-failed', 'x') })
    await h.say('200', 'four')
    h.client.on('session.prompt', () => { throw new HarniverseError('credential-missing', 'x') })
    await h.say('200', 'five')
    h.client.on('session.prompt', () => { throw new HarniverseError('rpc-rejected', 'x') })
    await h.say('200', 'six')
    expect(h.sent()).toEqual([
      'That session no longer exists. Send /new to start another.',
      'The assistant service rejected the request (model-unavailable).',
      'Something went wrong handling that message.',
      'The assistant service is unavailable right now.',
      'The assistant service is unavailable right now.',
      'The assistant service rejected the request (unknown).',
    ])
  })
})

describe('workspaces and isolation', () => {
  it('uses workspace aliases, never showing absolute paths', async () => {
    const h = await boot({ config: { workspaceAliases: ALIASES, members: [member({ workspaces: ['proj', 'docs'] })] } })
    await h.say('200', '/ws')
    await h.say('200', '/ws nope')
    await h.say('200', '/ws docs')
    await h.say('200', '/new')
    await h.say('200', '/whoami')
    await h.say('200', '/ws')
    expect(h.sent()[0]).toBe('Workspaces: proj, docs. Current: proj.')
    expect(h.sent()[1]).toBe('That workspace is not available to you.')
    expect(h.sent()[2]).toBe('New sessions will use docs. Send /new to start one.')
    expect(h.client.of('session.create')[0]?.payload.cwd).toBe('/srv/docs')
    expect(h.sent()[4]).toContain('Workspace: docs')
    expect(h.sent()[5]).toBe('Workspaces: proj, docs. Current: docs.')
    expect(h.sent().join('\n')).not.toContain('/srv')
  })

  it('shows the default workspace for a member without aliases', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/ws')
    expect(h.sent()).toEqual(['Workspaces: (none, using the default). Current: (default).'])
  })

  it('ignores a stale workspace selection the member no longer has', async () => {
    const h = await boot({ config: { workspaceAliases: ALIASES, members: [member({ workspaces: ['proj'] })] } })
    await h.state().table('bindings').put('fake-bot:direct:200', { workspace: 'docs' })
    await h.say('200', '/new')
    expect(h.client.of('session.create')[0]?.payload.cwd).toBe('/srv/proj')
  })

  it('forwards every request of a remote-host member to that host and opens a stream for it', async () => {
    const h = await boot({ config: { members: [member({ dshRemoteHost: REMOTE })] } })
    expect(h.client.muxes.map(mux => mux.options.remoteHost)).toEqual([undefined, REMOTE])
    await h.say('200', 'hello')
    await h.say('200', '/title Remote')
    await h.say('200', '/stop')
    await h.say('200', '/status')
    for (const call of h.client.calls) expect(call.options.remoteHost, call.method).toBe(REMOTE)
    expect(h.client.calls.map(call => call.method)).toEqual(expect.arrayContaining(['session.create', 'session.prompt', 'session.rename', 'host.describe']))
  })
})

describe('session commands', () => {
  it('lists own sessions, switches between them, and refuses bad numbers', async () => {
    const h = await boot({ config: { members: [member(), member({ id: 'bob', userId: '201' })] } })
    await h.say('200', '/sessions')
    await h.say('200', '/new')
    await h.say('201', '/new')
    const first = sessionId(h, 0)
    await h.say('200', '/new')
    await h.say('200', '/sessions')
    const list = h.sent().at(-1)!.split('\n')
    expect(list).toHaveLength(2)
    expect(list[0]).toContain('(current)')
    await h.say('200', '/session 2')
    expect(h.state().table('bindings').get('fake-bot:direct:200')?.sessionId).toBe(first)
    await h.say('200', '/session 9')
    await h.say('200', '/session x')
    expect(h.sent()[0]).toBe('You have no sessions yet.')
    expect(h.sent().slice(-2)).toEqual(Array(2).fill('Send /session <n> with a number from /sessions.'))
    await h.say('100', '/sessions')
    expect(h.sent().at(-1)!.split('\n')).toHaveLength(3)
  })

  it('lets an owner switch to any session', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/new')
    await h.say('100', '/session 1')
    expect(h.sent().at(-1)).toMatch(/^Switched to session/)
    expect(h.state().table('bindings').get('fake-bot:direct:100')?.sessionId).toBe(sessionId(h))
  })

  it('refuses a member a session created under an access profile they no longer have', async () => {
    const root = await seedState(async (state) => {
      await state.table('sessions').put('chat-old', {
        sessionId: 'chat-old', ownerKey: 'fake:200', botId: 'fake-bot', platform: 'fake',
        route: { kind: 'direct', chatId: '200' }, cwd: '/x', agentProfile: 'elevated', createdAt: 1,
      })
    })
    const h = await boot({ root, config: { members: [member()] } })
    await h.say('200', '/session 1')
    expect(h.sent()).toEqual(['That session is not available in this chat.'])
  })

  it('refuses sessions whose workspace the member no longer has and orders equal-age sessions by id', async () => {
    const base = { ownerKey: 'fake:200', botId: 'fake-bot', platform: 'fake', route: { kind: 'direct' as const, chatId: '200' }, cwd: '/x', createdAt: 5 }
    const root = await seedState(async (state) => {
      await state.table('sessions').put('chat-b', { ...base, sessionId: 'chat-b', workspace: 'gone' })
      await state.table('sessions').put('chat-a', { ...base, sessionId: 'chat-a' })
    })
    const h = await boot({ root, config: { members: [member()] } })
    await h.say('200', '/sessions')
    expect(h.sent()[0]).toBe('1. ...chat-a - \n2. ...chat-b gone'.replace('...chat-a - ', '...chat-a -'))
    await h.say('200', '/session 2')
    expect(h.sent().at(-1)).toBe('That session is not available in this chat.')
    await h.say('200', '/session 1')
    expect(h.sent().at(-1)).toBe('Switched to session ...chat-a.')
  })

  it('shows and selects models, and renames the session', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/model')
    await h.say('200', '/title x')
    expect(h.sent()).toEqual(Array(2).fill('No session yet. Send a message or /new first.'))
    await h.say('200', '/new')
    await h.say('200', '/model')
    await h.say('200', '/model p/m2')
    await h.say('200', '/model nonsense')
    await h.say('200', '/model p/none')
    await h.say('200', '/title')
    await h.say('200', '/title Project notes')
    expect(h.sent().slice(3)).toEqual([
      'Current: p/m1\nAvailable: p/m1, p/m2',
      'Model set to p/m2.',
      'Send /model <provider/model> with one of the available models.',
      'Send /model <provider/model> with one of the available models.',
      'Send /title <text>.',
      'Title set to "Project notes".',
    ])
    expect(h.client.of('session.selectModel')[0]?.payload).toMatchObject({ provider: 'p', model: 'm2' })
  })

  it('runs /compact and /plan as Harniverse commands and reports their outcome', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/compact')
    expect(h.sent()).toEqual(['No session yet. Send a message or /new first.'])
    await h.say('200', '/new')
    await h.say('200', '/compact')
    expect(h.client.of('commands/execute')[0]?.payload).toMatchObject({ line: '/compact', images: [] })
    h.client.on('commands/execute', () => ({ commandId: 'c', result: { kind: 'success' } }))
    await h.say('200', '/plan off')
    expect(h.client.of('commands/execute')[1]?.payload.line).toBe('/plan off')
    h.client.on('commands/execute', () => ({ commandId: 'c', result: { kind: 'error', text: '' } }))
    await h.say('200', '/plan')
    h.client.on('commands/execute', () => ({ commandId: 'c', result: { kind: 'error' } }))
    await h.say('200', '/plan')
    h.client.on('commands/execute', () => undefined)
    await h.say('200', '/compact')
    expect(h.sent().slice(2)).toEqual(['Compacted.', 'Done.', 'The command failed.', 'Harniverse did not recognize that command.'])
  })
})

describe('turn control', () => {
  it('stops only a running turn, and only its initiator or an owner', async () => {
    const h = await boot({ config: { members: [member(), member({ id: 'bob', userId: '201' })] } })
    await h.say('200', '/stop')
    await h.say('200', 'work')
    await h.say('200', '/stop')
    expect(h.sent().slice(0, 2)).toEqual(['No session yet.', 'Nothing is running.'])
    await run(h, lastRpc(h))
    await h.state().table('bindings').put('fake-bot:direct:201', { sessionId: sessionId(h) })
    await h.say('201', '/stop')
    expect(h.sent().at(-1)).toBe('Only the person who started this turn, or an owner, can stop it.')
    expect(h.client.of('session.cancel')).toHaveLength(0)
    await h.say('200', '/stop')
    expect(h.client.of('session.cancel')).toHaveLength(1)
    expect(h.sent().at(-1)).toBe('Stopping.')
    await h.state().table('bindings').put('fake-bot:direct:100', { sessionId: sessionId(h) })
    await h.say('100', '/stop')
    expect(h.client.of('session.cancel')).toHaveLength(2)
  })

  it('lets anyone stop a turn that was not started from chat', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/new')
    await h.client.mux().event(sessionId(h), 1, 'turn/start', { turn: 1 })
    await h.say('200', '/stop')
    expect(h.client.of('session.cancel')).toHaveLength(1)
  })

  it('steers only a running turn', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/steer go left')
    await h.say('200', 'work')
    await h.say('200', '/steer go left')
    expect(h.sent()[0]).toBe('Nothing is running to steer. Send a normal message instead.')
    expect(h.sent()[1]).toBe('Nothing is running to steer. Send a normal message instead.')
    await run(h, lastRpc(h))
    await h.say('200', '/steer go left')
    expect(h.client.of('session.prompt').at(-1)?.payload).toMatchObject({ mode: 'steer', content: [{ type: 'text', text: 'go left' }] })
  })

  it('lists and removes queued prompts of the requester', async () => {
    const h = await boot({ config: { members: [member(), member({ id: 'bob', userId: '201' })] } })
    await h.say('200', '/queue')
    await h.say('200', 'first job')
    await h.say('200', 'second job with a very long description that exceeds the preview width')
    await h.say('200', '/queue')
    expect(h.sent().at(-1)).toBe('1. [queue] first job\n2. [queue] second job with a very long description…')
    await h.say('200', '/unqueue 9')
    await h.say('200', '/unqueue x')
    expect(h.sent().slice(-2)).toEqual(Array(2).fill('Nothing to remove. Send /queue to see your queued prompts.'))
    await h.say('200', '/unqueue 1')
    expect(h.client.of('session.updateQueue')[0]?.payload).toEqual({ sessionId: sessionId(h), itemId: 'inbox-1', action: { kind: 'remove' } })
    await h.say('200', '/unqueue')
    expect(h.client.of('session.updateQueue')[1]?.payload.itemId).toBe('inbox-2')
    await h.say('200', '/queue')
    expect(h.sent().at(-1)).toBe('Nothing is queued.')
    await h.say('201', '/queue')
    await h.say('201', '/unqueue')
    expect(h.sent().at(-1)).toBe('Nothing to remove. Send /queue to see your queued prompts.')
  })

  it('reports status without leaking paths', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.client.mux().options.onState?.('open')
    await h.say('200', '/status')
    expect(h.sent()[0]).toContain('Harniverse events (local): open')
    expect(h.sent()[0]).toContain('Platform fake:fake-bot: running')
    expect(h.sent()[0]).toContain('Harniverse host: boot boot-1')
    expect(h.sent()[0]).toContain('Session: none')
    await h.say('200', 'work')
    h.client.mux().markOpen()
    await h.say('200', '/status')
    const status = h.sent().at(-1)!
    expect(status).toContain('Last prompt: queued')
    expect(status).toMatch(/Session: \.\.\.[0-9a-f]{8}$/)
    await run(h, lastRpc(h))
    await h.say('200', '/status')
    expect(h.sent().at(-1)).toMatch(/\(running\)$/)
    h.client.describeHost = () => Promise.reject(new Error('down'))
    await h.say('200', '/status')
    expect(h.sent().at(-1)).toContain('Harniverse host: unreachable')
  })
})

describe('attachments', () => {
  it('inlines images, uploads other files, and reports what it could not use', async () => {
    const h = await boot({
      config: { members: [member({ dshRemoteHost: undefined })], inbound: { maxFiles: 3, maxFileBytes: 1_000, maxInlineImageBytes: 10 } },
    })
    h.adapter.attachments.set('a1', { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
    h.adapter.attachments.set('a2', { bytes: new Uint8Array(20), mediaType: 'image/png' })
    h.adapter.attachments.set('a3', { bytes: new Uint8Array([9]), mediaType: 'text/plain' })
    h.adapter.attachments.set('big', { bytes: new Uint8Array(2_000), mediaType: 'text/plain' })
    await h.send(message('200', 'look', { attachments: [
      { attachmentId: 'a1', name: 'shot.png' }, { attachmentId: 'a2' }, { attachmentId: 'a3', name: 'notes.txt' },
      { attachmentId: 'big' },
    ] }))
    const content = h.client.of('session.prompt')[0]?.payload.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'text', text: 'look' })
    expect(content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'shot.png' })
    expect(content[2]).toMatchObject({ type: 'file', attachmentId: 'att-1', bytes: 20, mediaType: 'image/png' })
    expect(content[3]).toMatchObject({ type: 'file', attachmentId: 'att-2', bytes: 1, name: 'notes.txt', mediaType: 'text/plain' })
    expect(h.sent()).toEqual(['Only the first 3 attachments were used.'])
  })

  it('skips an attachment that cannot be downloaded and sends attachment-only prompts', async () => {
    const h = await boot({ config: { members: [member({ dshRemoteHost: REMOTE })] } })
    h.adapter.attachments.set('a1', { bytes: new Uint8Array(2_000_000_0), mediaType: 'application/zip' })
    await h.send(message('200', '', { attachments: [{ attachmentId: 'missing', name: 'gone.bin' }, { attachmentId: 'also-missing' }] }))
    expect(h.sent()).toEqual(['Could not use the attachment gone.bin.', 'Could not use the attachment also-missing.'])
    expect(h.client.of('session.prompt')).toHaveLength(0)
    await h.send(message('200', '', { attachments: [{ attachmentId: 'a1' }] }))
    expect(h.client.uploads[0]?.options).toEqual({ remoteHost: REMOTE })
    expect((h.client.of('session.prompt')[0]?.payload.content as unknown[])).toHaveLength(1)
  })

  it('inlines an unnamed image without a name field', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.adapter.attachments.set('a1', { bytes: new Uint8Array([1]), mediaType: 'image/jpeg' })
    await h.send(message('200', '', { attachments: [{ attachmentId: 'a1' }] }))
    expect(h.client.of('session.prompt')[0]?.payload.content).toEqual([{ type: 'image', mediaType: 'image/jpeg', data: 'AQ==' }])
  })

  it('ignores an empty message with no attachments', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '')
    expect(h.adapter.transcript).toHaveLength(0)
    expect(h.client.calls).toHaveLength(0)
  })

  it('aborts an attachment that exceeds the cap mid-stream', async () => {
    const h = await boot({ config: { members: [member()], inbound: { maxFiles: 5, maxFileBytes: 10, maxInlineImageBytes: 10 } } })
    h.adapter.fetchAttachment = () => Promise.resolve({
      mediaType: 'text/plain',
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6))
          controller.enqueue(new Uint8Array(6))
          controller.close()
        },
      }),
    })
    await h.send(message('200', 'x', { attachments: [{ attachmentId: 'a' }] }))
    expect(h.sent()[0]).toBe('Could not use the attachment a.')
  })
})
