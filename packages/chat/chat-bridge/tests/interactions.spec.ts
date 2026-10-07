/** Approval and question routing: owners get approvals, members cannot answer unless granted, everything times out. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import type { FakeOutbound } from '@deepseek-ai/dsh-chat-adapter-fake'
import { Interactions } from '../src/interactions.ts'
import { liveSession } from '../src/live.ts'
import { boot, cleanup, member, message, seedState, type Harness } from './helpers.ts'
import { begin, delta, finish, type Turn } from './turn.ts'

afterEach(cleanup)

type Interaction = Extract<FakeOutbound, { kind: 'interaction' }>

function interactions(h: Harness): Interaction[] {
  return h.adapter.transcript.filter((entry): entry is Interaction => entry.kind === 'interaction')
}

function click(userId: string, actionId: string, isBot = false): ChatInbound {
  return { type: 'interaction', interactionId: 'i', actionId, route: { kind: 'direct', chatId: userId }, sender: { userId, isBot } }
}

async function approval(turn: Turn, options: { rpcId?: string; approvalId?: string; callId?: string } = {}): Promise<void> {
  await turn.mux.push({
    type: 'approval/requested', sessionId: turn.sessionId, approvalId: options.approvalId ?? 'ap1', toolName: 'bash',
    ...options.callId === undefined ? {} : { callId: options.callId }, reason: 'needs write access',
  }, options.rpcId ?? 'rpc-a1')
}

function pendingId(h: Harness): string {
  return /^(?:approve|reject):(.+)$/.exec(interactions(h)[0]!.prompt.actions[0]!.id)![1]!
}

const members = [member()]

describe('approvals', () => {
  it('sends the card only to the owner, with the tool arguments, and tells the member it was forwarded', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await turn.next('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' })
    await approval(turn, { callId: 'c1' })
    const [card] = interactions(h)
    expect(interactions(h)).toHaveLength(1)
    expect(card).toMatchObject({ route: { kind: 'direct', chatId: '100' }, prompt: { kind: 'approval' } })
    expect(card!.prompt.body).toContain('Approval needed for bash')
    expect(card!.prompt.body).toContain('requested by alice')
    expect(card!.prompt.body).toContain('Arguments: {"command":"echo hi"}')
    expect(card!.prompt.body).toContain('Reason: needs write access')
    expect(card!.prompt.actions.map(action => action.label)).toEqual(['Approve once', 'Reject'])
    expect(h.sent().at(-1)).toBe('The tool request was forwarded to the owner for approval.')
    expect(h.client.responds).toHaveLength(0)
  })

  it('lets the owner approve once or reject, responding with the request rpcId and settling the card', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    const id = pendingId(h)
    await h.send(click('100', `approve:${id}`))
    expect(h.client.responds).toEqual([{
      rpcId: 'rpc-a1',
      result: { ok: true, value: { sessionId: turn.sessionId, approvalId: 'ap1', outcome: 'allowed-once' } },
      options: {},
    }])
    expect(h.adapter.transcript.at(-2)).toMatchObject({ kind: 'settle', state: 'answered' })
    expect(h.sent().at(-1)).toBe('Approved once.')
    await h.send(click('100', `approve:${id}`))
    expect(h.sent().at(-1)).toBe('That request is no longer pending.')
    await approval(turn, { rpcId: 'rpc-a2', approvalId: 'ap2' })
    await h.send(click('100', `reject:${/^(?:approve|reject):(.+)$/.exec(interactions(h)[1]!.prompt.actions[0]!.id)![1]!}`))
    expect(h.client.responds[1]?.result).toMatchObject({ value: { approvalId: 'ap2', outcome: 'rejected' } })
    expect(h.sent().at(-1)).toBe('Rejected.')
  })

  it('ignores a member answering when the config does not grant it', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    await h.send(click('200', `approve:${pendingId(h)}`))
    expect(h.client.responds).toHaveLength(0)
    expect(h.sent().at(-1)).toBe('You cannot answer this request.')
  })

  it('ignores unpaired senders, bots, and malformed actions', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    const before = h.adapter.transcript.length
    await h.send(click('999', `approve:${pendingId(h)}`))
    await h.send(click('100', 'approve:nonexistent', true))
    await h.send(click('100', 'noise'))
    await h.send(click('100', 'answer:abc:x'))
    await h.send(click('100', 'approve'))
    expect(h.adapter.transcript).toHaveLength(before)
    expect(h.client.responds).toHaveLength(0)
  })

  it('also asks the member when the config grants answering, and lets either answer', async () => {
    const h = await boot({ config: { members: [member({ answerOwnApprovals: true })] } })
    const turn = await begin(h)
    await approval(turn)
    expect(interactions(h).map(card => card.route.chatId)).toEqual(['100', '200'])
    expect(h.sent().join('\n')).not.toContain('forwarded')
    await h.send(click('200', `approve:${pendingId(h)}`))
    expect(h.client.responds).toHaveLength(1)
    expect(h.adapter.transcript.filter(entry => entry.kind === 'settle')).toHaveLength(2)
  })

  it('sends an owner-started approval only to owners without a forwarding notice', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h, '100')
    await approval(turn)
    expect(interactions(h).map(card => card.route.chatId)).toEqual(['100'])
    expect(h.sent().join('\n')).not.toContain('forwarded')
  })

  it('routes a group-started approval to the owner chat and tells the group', async () => {
    const h = await boot({ config: { members } })
    await h.say('100', '/pair-group', { kind: 'group' })
    await h.say('200', 'go', { kind: 'group' })
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    const rpcId = String(h.client.of('session.prompt')[0]?.options.rpcId)
    await h.client.mux().event(sessionId, 0, 'turn/start', { turn: 1 })
    await h.client.mux().event(sessionId, 1, 'user/message', { source: { rpcId } })
    await h.client.mux().push({ type: 'approval/requested', sessionId, approvalId: 'ap1', toolName: 'bash' }, 'rpc-a1')
    expect(interactions(h).map(card => card.route)).toEqual([{ kind: 'direct', chatId: '100' }])
    const notice = h.adapter.transcript.at(-1)
    expect(notice).toMatchObject({ kind: 'send', route: { kind: 'group', chatId: 'group-1' } })
  })

  it('falls back to typed commands on platforms without buttons and never reads approval words', async () => {
    const h = await boot({ config: { members }, capabilities: { interactionButtons: false } })
    const turn = await begin(h)
    await approval(turn)
    const card = h.adapter.transcript.find(entry => entry.kind === 'send' && entry.message.text.startsWith('Approval needed'))
    expect(card).toBeDefined()
    const sent = card!
    const text = sent.kind === 'send' ? sent.message.text : ''
    const id = /\/approve (\S+) or/.exec(text)![1]!
    await h.say('200', 'yes, approved')
    await h.say('200', `/approve ${id}`)
    expect(h.client.responds).toHaveLength(0)
    expect(h.sent().at(-1)).toBe('You cannot answer this request.')
    await h.say('100', `/approve ${id}`)
    expect(h.client.responds).toHaveLength(1)
    expect(h.adapter.transcript.filter(entry => entry.kind === 'edit').at(-1)).toMatchObject({ message: { text: 'Approved once.' } })
    await h.say('100', '/reject')
    expect(h.sent().at(-1)).toBe('That request is no longer pending.')
    await h.say('100', '/approve')
    expect(h.sent().at(-1)).toBe('That request is no longer pending.')
  })

  it('leaves plain cards alone when the platform cannot edit', async () => {
    const h = await boot({ config: { members }, capabilities: { interactionButtons: false, editOutbound: false } })
    const inbound = h.adapter
    delete (inbound as { edit?: unknown }).edit
    const turn = await begin(h)
    await approval(turn)
    const id = /\/approve (\S+) or/.exec(h.sent().find(text => text.startsWith('Approval needed'))!)![1]!
    await h.say('100', `/approve ${id}`)
    expect(h.client.responds).toHaveLength(1)
  })

  it('rejects at once when no owner can be reached', async () => {
    const h = await boot({ owners: [], config: { members } })
    const turn = await begin(h)
    await approval(turn)
    expect(h.client.responds[0]?.result).toMatchObject({ value: { outcome: 'rejected' } })
    expect(h.sent().at(-1)).toBe('No owner is reachable, so the tool request was rejected.')
    const unreachable = await boot({ config: { members } })
    unreachable.adapter.directRoutes.set('100', undefined)
    const other = await begin(unreachable)
    await approval(other)
    expect(unreachable.client.responds[0]?.result).toMatchObject({ value: { outcome: 'rejected' } })
  })

  it('rejects at once without a notice when no chat started the turn and no owner is reachable', async () => {
    const h = await boot({ owners: [], config: { members } })
    await h.say('200', '/new')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    await h.client.mux().push({ type: 'approval/requested', sessionId, approvalId: 'ap1', toolName: 'bash' }, 'rpc-a1')
    expect(h.client.responds).toHaveLength(1)
    expect(h.sent()).toHaveLength(1)
  })

  it('rejects after the timeout, settles the cards, and tells the requester', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = await boot({ config: { members, approvalTimeoutMs: 5_000 } })
    const turn = await begin(h)
    await approval(turn)
    const id = pendingId(h)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.client.responds[0]?.result).toMatchObject({ value: { outcome: 'rejected' } })
    expect(h.adapter.transcript.some(entry => entry.kind === 'settle' && entry.state === 'expired')).toBe(true)
    expect(h.sent().at(-1)).toBe('The tool request timed out and was rejected.')
    await h.send(click('100', `approve:${id}`))
    expect(h.sent().at(-1)).toBe('That request is no longer pending.')
    expect(h.client.responds).toHaveLength(1)
    await finish(turn)
  })

  it('expires silently when the turn is over before the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = await boot({ config: { members, approvalTimeoutMs: 1_000 } })
    const turn = await begin(h)
    await approval(turn)
    await turn.next('assistant/chunk', delta('x'))
    await finish(turn)
    const before = h.adapter.transcript.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.client.responds).toHaveLength(1)
    expect(h.adapter.transcript.slice(before).some(entry => entry.kind === 'send')).toBe(false)
  })

  it('settles cards when the approval was answered elsewhere', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    await turn.mux.push({ type: 'approval/resolved', sessionId: turn.sessionId, approvalId: 'ap1', outcome: 'allowed-once' })
    await turn.mux.push({ type: 'approval/resolved', sessionId: turn.sessionId, approvalId: 'unknown', outcome: 'rejected' })
    expect(h.adapter.transcript.filter(entry => entry.kind === 'settle')).toHaveLength(1)
    await h.send(click('100', `approve:${pendingId(h)}`))
    expect(h.client.responds).toHaveLength(0)
  })

  it('expires everything bound to a restarted host', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    turn.mux.options.onHostRestart?.('boot-1', 'boot-2')
    await vi.waitFor(() => { expect(h.adapter.transcript.some(entry => entry.kind === 'settle' && entry.state === 'expired')).toBe(true) })
    await h.send(click('100', `approve:${pendingId(h)}`))
    expect(h.sent().at(-1)).toBe('That request is no longer pending.')
  })

  it('keeps the request answerable when the response could not be delivered', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await approval(turn)
    const id = pendingId(h)
    h.client.receipt = new Error('network down')
    await h.send(click('100', `approve:${id}`))
    expect(h.sent().at(-1)).toBe('Could not reach the Harniverse service; try again.')
    h.client.receipt = { accepted: false, reason: 'not-pending' }
    await h.send(click('100', `approve:${id}`))
    expect(h.sent().at(-1)).toBe('Approved once.')
  })

  it('refuses a concurrent second answer while the first is being delivered', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const responds: string[] = []
    const interactions = new Interactions({
      config: { approvalTimeoutMs: 60_000, questionTimeoutMs: 60_000 },
      messenger: {
        adapterFor: () => undefined,
        card: () => Promise.resolve(undefined),
        settle: () => Promise.resolve(),
        reply: () => Promise.resolve(undefined),
      } as never,
      client: { respond: async (rpcId: string) => { await gate; responds.push(rpcId); return { accepted: true } } } as never,
      session: () => liveSession({ sessionId: 's', ownerKey: 'fake:200', botId: 'b', platform: 'fake', route: { kind: 'direct', chatId: '200' }, cwd: '/x', createdAt: 1 }),
      owners: () => [{ key: 'fake:100', target: { platform: 'fake', botId: 'b', route: { kind: 'direct', chatId: '100' } } }],
      actor: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    })
    await interactions.approvalRequested('rpc-1', { type: 'approval/requested', sessionId: 's', approvalId: 'a', toolName: 'bash' }, undefined)
    const id = interactions.table.filter(() => true)[0]!.id
    const first = interactions.answerApproval(id, true, 'fake:100')
    expect(await interactions.answerApproval(id, false, 'fake:100')).toBe('That request is already being answered.')
    release()
    expect(await first).toBe('Approved once.')
    expect(responds).toEqual(['rpc-1'])
    interactions.dispose()
  })

  it('ignores approvals for sessions the bridge does not own', async () => {
    const h = await boot({ config: { members } })
    await h.say('200', '/new')
    await h.client.mux().push({ type: 'approval/requested', sessionId: 'someone-elses', approvalId: 'x', toolName: 'bash' }, 'rpc')
    expect(interactions(h)).toHaveLength(0)
    expect(h.client.responds).toHaveLength(0)
  })

  it('delivers remote-host responses through the remote host', async () => {
    const h = await boot({ config: { members: [member({ dshRemoteHost: '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39' })] } })
    const turn = await begin(h)
    await approval(turn)
    await h.send(click('100', `approve:${pendingId(h)}`))
    expect(h.client.responds[0]?.options).toEqual({ remoteHost: '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39' })
  })
})

describe('approval edge cases', () => {
  it('routes to an owner that paired through a code', async () => {
    const root = await seedState(async (state) => {
      await state.table('members').put('fake:500', { role: 'owner', pairedAt: 1 })
      await state.table('members').put('fake:501', { role: 'member', memberId: 'alice', pairedAt: 1 })
    })
    const h = await boot({ root, owners: [], config: { members } })
    const turn = await begin(h)
    await approval(turn)
    expect(interactions(h).map(card => card.route.chatId)).toEqual(['500'])
    await h.send(click('500', `approve:${pendingId(h)}`))
    expect(h.client.responds).toHaveLength(1)
  })

  it('rejects a remote-host request quietly when no owner is reachable', async () => {
    const remote = '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39'
    const h = await boot({ owners: [], config: { members: [member({ dshRemoteHost: remote })] } })
    const turn = await begin(h)
    await approval(turn)
    expect(h.client.responds[0]?.options).toEqual({ remoteHost: remote })
    h.client.receipt = new Error('down')
    await approval(turn, { rpcId: 'rpc-a2', approvalId: 'ap2' })
    expect(h.client.responds).toHaveLength(2)
  })

  it('does not notify a requester whose adapter is gone, and skips a timeout that lost the race to an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const live = liveSession({ sessionId: 's', ownerKey: 'fake:200', botId: 'b', platform: 'fake', route: { kind: 'direct', chatId: '200' }, cwd: '/x', createdAt: 1 })
    live.turn = { number: 1, text: '', separate: false, plain: false, origin: { rpcId: 'r', actorKey: 'fake:200', label: 'alice', platform: 'fake', botId: 'b', route: { kind: 'direct', chatId: '200' }, mode: 'queue', preview: '' } }
    const responds: string[] = []
    const interactionsLayer = new Interactions({
      config: { approvalTimeoutMs: 1_000, questionTimeoutMs: 1_000 },
      messenger: {
        adapterFor: () => undefined,
        card: () => Promise.resolve(undefined),
        settle: () => Promise.resolve(),
        reply: () => Promise.resolve(undefined),
      } as never,
      client: { respond: async (rpcId: string) => { await gate; responds.push(rpcId); return { accepted: true } } } as never,
      session: () => live,
      owners: () => [{ key: 'fake:100', target: { platform: 'fake', botId: 'b', route: { kind: 'direct', chatId: '100' } } }],
      actor: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    })
    await interactionsLayer.approvalRequested('rpc-1', { type: 'approval/requested', sessionId: 's', approvalId: 'a', toolName: 'bash' }, undefined)
    const id = interactionsLayer.table.filter(() => true)[0]!.id
    const answering = interactionsLayer.answerApproval(id, true, 'fake:100')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(responds).toEqual([])
    release()
    await answering
    expect(responds).toEqual(['rpc-1'])
    await interactionsLayer.questionRequested('rpc-2', { type: 'question/requested', sessionId: 's', questions: [{ id: 'q', question: '?' }] }, undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(responds).toEqual(['rpc-1', 'rpc-2'])
    interactionsLayer.dispose()
  })
})

describe('questions', () => {
  const single = { id: 'q1', question: 'Pick one', options: [{ label: 'Red' }, { label: 'Blue', description: 'cool' }] }

  async function ask(turn: Turn, questions: unknown[], rpcId = 'rpc-q1'): Promise<void> {
    await turn.mux.push({ type: 'question/requested', sessionId: turn.sessionId, questions } as never, rpcId)
  }

  it('offers options as buttons in the chat that started the turn and answers with the chosen label', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await ask(turn, [single])
    const [card] = interactions(h)
    expect(card).toMatchObject({ route: { kind: 'direct', chatId: '200' }, prompt: { kind: 'question' } })
    expect(card!.prompt.body).toContain('Q1. Pick one')
    expect(card!.prompt.body).toContain('2) Blue - cool')
    expect(card!.prompt.actions.map(action => action.label)).toEqual(['Red', 'Blue'])
    await h.send(click('999', card!.prompt.actions[1]!.id))
    await h.send(click('200', card!.prompt.actions[1]!.id))
    expect(h.client.responds).toEqual([{
      rpcId: 'rpc-q1',
      result: { ok: true, value: { sessionId: turn.sessionId, answer: { answers: [{ id: 'q1', selected: ['Blue'] }] } } },
      options: {},
    }])
    expect(h.sent().at(-1)).toBe('Answer sent.')
    await h.send(click('200', card!.prompt.actions[1]!.id))
    expect(h.sent().at(-1)).toBe('That question is no longer pending.')
  })

  it('lets only the initiator or an owner answer', async () => {
    const h = await boot({ config: { members: [member(), member({ id: 'bob', userId: '201' })] } })
    const turn = await begin(h)
    await ask(turn, [single])
    await h.send(click('201', interactions(h)[0]!.prompt.actions[0]!.id))
    expect(h.sent().at(-1)).toBe('You cannot answer this question.')
    await h.send(click('100', interactions(h)[0]!.prompt.actions[0]!.id))
    expect(h.client.responds).toHaveLength(1)
  })

  it('takes typed answers with /answer for several questions, free text, and multi-select', async () => {
    const h = await boot({ config: { members }, capabilities: { interactionButtons: false } })
    const turn = await begin(h)
    await ask(turn, [single, { id: 'q2', question: 'Why?' }, { id: 'q3', question: 'Toppings', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }])
    const body = h.sent().find(text => text.startsWith('Q1.'))!
    expect(body).toContain('(several options allowed')
    const id = /\/answer (\S+) /.exec(body)![1]!
    await h.say('200', '/answer')
    await h.say('200', `/answer ${id} 1`)
    await h.say('200', `/answer ${id} 1 ; why ; 1,9`)
    await h.say('200', `/answer ${id} 1,2 ; why ; 1`)
    await h.say('200', `/answer ${id} 5 ; why ; 1`)
    expect(h.sent().slice(-5)).toEqual([
      'Send /answer <id> <answers>.',
      'Expected 3 non-empty answer(s) separated by ";".',
      'Answer 3 names an option that does not exist.',
      'Answer 1 allows one option.',
      'Answer 1 names an option that does not exist.',
    ])
    await h.say('200', `/answer ${id} 2 ; because ; 1, 3`)
    expect(h.client.responds[0]?.result).toMatchObject({
      value: { answer: { answers: [{ id: 'q1', selected: ['Blue'] }, { id: 'q2', selected: [], custom: 'because' }, { id: 'q3', selected: ['A', 'C'] }] } },
    })
    await h.say('200', `/answer ${id} x`)
    expect(h.sent().at(-1)).toBe('That question is no longer pending.')
  })

  it('does not offer buttons for a multi-select question and accepts a free-text answer for an option question', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await ask(turn, [{ id: 'q', question: 'Many', multiSelect: true, options: [{ label: 'A' }] }])
    const card = h.adapter.transcript.find(entry => entry.kind === 'send' && entry.message.text.startsWith('Q1.'))
    expect(card).toBeDefined()
    expect(interactions(h)).toHaveLength(0)
    const sent = card!
    const id = /\/answer (\S+) /.exec(sent.kind === 'send' ? sent.message.text : '')![1]!
    await h.say('200', `/answer ${id} something else`)
    expect(h.client.responds[0]?.result).toMatchObject({ value: { answer: { answers: [{ id: 'q', selected: [], custom: 'something else' }] } } })
  })

  it('cancels after the timeout and tells the requester', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = await boot({ config: { members, questionTimeoutMs: 2_000 } })
    const turn = await begin(h)
    await ask(turn, [single])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.client.responds[0]?.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(h.sent().at(-1)).toBe('The question timed out and was cancelled.')
    expect(h.adapter.transcript.some(entry => entry.kind === 'settle' && entry.state === 'expired')).toBe(true)
  })

  it('settles when answered or cancelled elsewhere', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    await ask(turn, [single])
    await turn.mux.push({ type: 'question/resolved', sessionId: turn.sessionId, questionRpcId: 'rpc-q1', outcome: 'cancelled' })
    await turn.mux.push({ type: 'question/resolved', sessionId: turn.sessionId, questionRpcId: 'unknown', outcome: 'answered' })
    expect(h.adapter.transcript.filter(entry => entry.kind === 'settle')).toHaveLength(1)
  })

  it('asks owners when no chat started the turn, and cancels when nobody is reachable', async () => {
    const h = await boot({ config: { members } })
    await h.say('200', '/new')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    await h.client.mux().push({ type: 'question/requested', sessionId, questions: [single] } as never, 'rpc-q9')
    expect(interactions(h)[0]?.route.chatId).toBe('100')
    const nobody = await boot({ owners: [], config: { members } })
    await nobody.say('200', '/new')
    await nobody.client.mux().push({ type: 'question/requested', sessionId: String(nobody.client.of('session.create')[0]?.payload.sessionId), questions: [single] } as never, 'rpc-q8')
    expect(nobody.client.responds[0]?.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await nobody.client.mux().push({ type: 'question/requested', sessionId: 'not-ours', questions: [single] } as never, 'rpc-q7')
    expect(nobody.client.responds).toHaveLength(1)
  })

  it('keeps a question answerable after a delivery failure and reports an unreachable card', async () => {
    const h = await boot({ config: { members } })
    const turn = await begin(h)
    h.adapter.failNext('interaction', new Error('card failed'))
    await ask(turn, [single])
    expect(interactions(h)).toHaveLength(0)
    const retry = await boot({ config: { members } })
    const second = await begin(retry)
    await ask(second, [single])
    retry.client.receipt = new Error('down')
    await retry.send(click('200', interactions(retry)[0]!.prompt.actions[0]!.id))
    expect(retry.sent().at(-1)).toBe('Could not reach the Harniverse service; try again.')
  })

  it('cancels at once without any reachable owner when the turn has no chat origin', async () => {
    const h = await boot({ config: { members } })
    h.adapter.directRoutes.set('100', undefined)
    await h.say('200', '/new')
    const sessionId = String(h.client.of('session.create')[0]?.payload.sessionId)
    await h.client.mux().push({ type: 'question/requested', sessionId, questions: [single] } as never, 'rpc-q9')
    expect(h.client.responds[0]?.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('reports a failed response delivery and a failed rejection on timeout quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = await boot({ config: { members, approvalTimeoutMs: 1_000 } })
    const turn = await begin(h)
    h.client.receipt = new Error('down')
    await approval(turn)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.client.responds).toHaveLength(1)
    const bare = message('200', 'hi')
    expect(bare.type).toBe('message')
  })
})
