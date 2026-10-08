/** Admission: default deny, one-time pairing codes, groups, duplicates, and the closed command table. */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueCode } from '../src/pairing.ts'
import { boot, cleanup, member, message } from './helpers.ts'

afterEach(cleanup)

describe('default deny', () => {
  it('ignores an unpaired direct message but hints at pairing once per hour', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = await boot()
    await h.say('999', 'hello')
    await h.say('999', 'hello again')
    expect(h.sent()).toEqual(['Send /pair <code> to join. Ask an owner for a pairing code.'])
    expect(h.client.calls).toHaveLength(0)
    vi.setSystemTime(Date.now() + 3_600_001)
    await h.say('999', 'third')
    expect(h.sent()).toHaveLength(2)
  })

  it('stays silent for unpaired group messages, bot senders, and unaddressed group chatter', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('999', 'hi', { kind: 'group' })
    await h.say('200', 'hi', { isBot: true })
    await h.say('200', 'hi', { kind: 'group', addressed: false })
    expect(h.adapter.transcript).toHaveLength(0)
    expect(h.client.calls).toHaveLength(0)
  })

  it('replies to an unpaired /pair with a bad code and never reaches the API', async () => {
    const h = await boot()
    await h.say('999', '/pair')
    await h.say('999', '/pair AAAAA-AAAAA')
    expect(h.sent()).toEqual(['That pairing code is not valid or has expired.', 'That pairing code is not valid or has expired.'])
    expect(h.client.calls).toHaveLength(0)
  })
})

describe('pairing', () => {
  it('pairs an owner with a one-time code and refuses reuse', async () => {
    const h = await boot({ owners: [] })
    const code = await issueCode(h.state().table('codes'), { kind: 'owner', expiresAt: Date.now() + 60_000 })
    await h.say('500', `/pair ${code.toLowerCase()}`)
    await h.say('500', '/help')
    await h.say('501', `/pair ${code}`)
    expect(h.sent()[0]).toBe('Paired as owner. Send /help for the commands.')
    expect(h.sent()[1]).toContain('/invite <member>')
    expect(h.sent()[2]).toBe('That pairing code is not valid or has expired.')
    expect(h.state().table('members').get('fake:500')).toMatchObject({ role: 'owner' })
    await h.say('500', '/pair ABCDE-FGHJK')
    expect(h.sent().at(-1)).toBe('You are already paired.')
  })

  it('rejects an expired code and removes it', async () => {
    const h = await boot({ owners: [] })
    const code = await issueCode(h.state().table('codes'), { kind: 'owner', expiresAt: Date.now() - 1 })
    await h.say('500', `/pair ${code}`)
    expect(h.sent()).toEqual(['That pairing code is not valid or has expired.'])
    expect(h.state().table('codes').size).toBe(0)
  })

  it('pairs a member through an owner invite, once, and revokes them', async () => {
    const h = await boot({ config: { members: [member({ userId: undefined })] } })
    await h.say('100', '/invite alice')
    const code = /: ([0-9A-Z]{5}-[0-9A-Z]{5})\./.exec(h.sent()[0]!)![1]!
    expect(h.sent()[0]).toContain('expires in 24 hours')
    await h.say('201', `/pair ${code}`)
    expect(h.sent()[1]).toBe('Paired as alice. Send /help for the commands.')
    await h.say('202', `/pair ${code}`)
    expect(h.sent()[2]).toBe('That pairing code is not valid or has expired.')
    await h.say('201', '/whoami')
    expect(h.sent()[3]).toContain('fake:201 - member alice')
    await h.say('100', '/invite alice')
    expect(h.sent()[4]).toBe('alice is already paired. Use /revoke first to issue a new code.')
    await h.say('100', '/members')
    expect(h.sent()[5]).toContain('alice (fake): paired;')
    await h.say('100', '/revoke alice')
    expect(h.sent()[6]).toBe('alice was unbound.')
    await h.say('201', 'anything')
    expect(h.sent()[7]).toContain('Send /pair <code>')
    await h.say('100', '/revoke alice')
    expect(h.sent()[8]).toBe('alice is not paired.')
  })

  it('refuses a member code redeemed on another platform or for an unknown or already bound member', async () => {
    const h = await boot({ config: { members: [member({ userId: undefined, platform: 'other' }), member({ id: 'bob', userId: '300' })] } })
    const codes = h.state().table('codes')
    const wrongPlatform = await issueCode(codes, { kind: 'member', memberId: 'alice', expiresAt: Date.now() + 60_000 })
    const unknown = await issueCode(codes, { kind: 'member', memberId: 'ghost', expiresAt: Date.now() + 60_000 })
    const staticMember = await issueCode(codes, { kind: 'member', memberId: 'bob', expiresAt: Date.now() + 60_000 })
    for (const code of [wrongPlatform, unknown, staticMember]) await h.say('999', `/pair ${code}`)
    expect(h.sent()).toEqual(Array(3).fill('That pairing code cannot be used here.'))
    expect(h.state().table('members').size).toBe(0)
  })

  it('tells the owner about invalid invite, revoke, and static members', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('100', '/invite nobody')
    await h.say('100', '/invite alice')
    await h.say('100', '/revoke nobody')
    await h.say('100', '/revoke alice')
    await h.say('100', '/members')
    expect(h.sent()).toEqual([
      'Send /invite <member> with a configured member id.',
      'alice is already paired. Use /revoke first to issue a new code.',
      'Send /revoke <member> with a configured member id.',
      'alice is bound in the configuration; edit the configuration to remove them.',
      expect.stringContaining('alice (fake): static identity;'),
    ])
  })

  it('lists no members when none are configured', async () => {
    const h = await boot()
    await h.say('100', '/members')
    expect(h.sent()).toEqual(['No members are configured.'])
  })
})

describe('closed command table', () => {
  it('refuses unknown and path-like commands without calling the API or the model', async () => {
    const h = await boot({ config: { members: [member()] } })
    for (const text of ['/permission danger-full-access', '/etc/passwd', '/', '/export', '/context']) await h.say('200', text)
    expect(h.sent()).toEqual(Array(5).fill('Unknown command. Send /help for the list.'))
    expect(h.client.calls).toHaveLength(0)
  })

  it('refuses a command the member was not granted and owner-only commands', async () => {
    const h = await boot({ config: { members: [member({ commands: ['ask'] })] } })
    await h.say('200', '/new')
    await h.say('200', '/invite alice')
    await h.say('200', '/pair-group', { kind: 'group' })
    await h.say('200', '/stop')
    expect(h.sent()).toEqual(['That command is not enabled for you.', 'Only an owner can use that command.', 'That command is not enabled for you.'])
    expect(h.client.calls).toHaveLength(0)
  })

  it('refuses a plain prompt from a member without the ask command', async () => {
    const h = await boot({ config: { members: [member({ commands: ['stop'] })] } })
    await h.say('200', 'please help')
    expect(h.sent()).toEqual(['You cannot send prompts here.'])
    expect(h.client.calls).toHaveLength(0)
  })

  it('lists exactly the commands a sender may use', async () => {
    const h = await boot({ config: { members: [member({ commands: ['ask', 'stop'] })] } })
    await h.say('200', '/help')
    const text = h.sent()[0]!
    expect(text).toContain('/ask <text>')
    expect(text).toContain('/stop')
    expect(text).not.toContain('/new')
    expect(text).not.toContain('/invite')
    expect(text).not.toContain('/pair ')
  })

  it('reports usage for an empty /ask and /steer', async () => {
    const h = await boot()
    await h.say('100', '/ask')
    await h.say('100', '/steer')
    expect(h.sent()).toEqual(['Send /ask <text>.', 'Send /steer <text>.'])
  })
})

describe('duplicates', () => {
  it('handles a redelivered message id once and sends the prompt with a stable Idempotency-Key', async () => {
    const h = await boot()
    const event = message('100', 'hello', { id: 'dup-1' })
    await Promise.all([h.send(event), h.send(event)])
    await h.send(event)
    expect(h.client.of('session.prompt')).toHaveLength(1)
    const expected = createHash('sha256').update('fake:fake-bot:dup-1').digest('hex')
    expect(h.client.of('session.prompt')[0]?.options.idempotencyKey).toBe(expected)
    expect(h.client.of('session.create')[0]?.options.idempotencyKey).toBe(expected)
  })

  it('bounds the retained ids', async () => {
    const h = await boot({ config: { seenLimit: 10 } })
    for (let index = 0; index < 15; index += 1) await h.say('100', '/whoami', { id: `m-${String(index)}` })
    expect(h.state().table('seen').size).toBeLessThanOrEqual(10)
    expect(h.state().table('seen').size).toBeGreaterThan(5)
  })
})

describe('groups', () => {
  it('needs an owner binding, prefixes prompts with the sender, and drops unpaired senders', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', 'hello', { kind: 'group' })
    expect(h.adapter.transcript).toHaveLength(0)
    await h.say('100', '/pair-group', { kind: 'group' })
    expect(h.sent()[0]).toBe('This group can now talk to the assistant. Mention the bot or reply to it.')
    await h.say('200', 'summarize this', { kind: 'group', displayName: 'Alice [admin]\n' })
    await h.say('999', 'hi', { kind: 'group' })
    const prompt = h.client.of('session.prompt')[0]!
    expect(prompt.payload.content).toEqual([{ type: 'text', text: '[fake·Alice admin] summarize this' }])
    expect(h.client.of('session.prompt')).toHaveLength(1)
    await h.say('100', '/unpair-group', { kind: 'group' })
    expect(h.sent().at(-1)).toBe('This group is no longer connected.')
    await h.say('200', 'again', { kind: 'group' })
    expect(h.client.of('session.prompt')).toHaveLength(1)
  })

  it('falls back to the user id for an unnamed sender and asks for a group for the group commands', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('100', '/pair-group')
    await h.say('100', '/unpair-group')
    expect(h.sent()).toEqual(['Send this command inside the group chat.', 'Send this command inside the group chat.'])
    await h.say('100', '/pair-group', { kind: 'group' })
    await h.say('200', 'hello', { kind: 'group' })
    expect(h.client.of('session.prompt')[0]?.payload.content).toEqual([{ type: 'text', text: '[fake·200] hello' }])
  })

  it('refuses a member whose access profile differs from the group session', async () => {
    const h = await boot({ config: { members: [member(), member({ id: 'carol', userId: '300', agentProfile: 'other' })] } })
    await h.say('100', '/pair-group', { kind: 'group' })
    await h.say('200', 'first', { kind: 'group' })
    await h.say('300', 'second', { kind: 'group' })
    expect(h.sent().at(-1)).toBe('Something went wrong handling that message.')
    expect(h.client.of('session.prompt')).toHaveLength(1)
  })
})

describe('static identities', () => {
  it('serves a configured member and owner without pairing', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/whoami')
    await h.say('100', '/whoami')
    expect(h.sent()[0]).toContain('fake:200 - member alice')
    expect(h.sent()[1]).toContain('fake:100 - owner')
  })
})

describe('more admission paths', () => {
  it('ignores edited and deleted messages', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.send({ type: 'message-edited', messageId: 'm', route: { kind: 'direct', chatId: '200' }, sender: { userId: '200', isBot: false }, text: '/whoami', controlText: '/whoami', platformTime: 1 })
    await h.send({ type: 'message-deleted', messageId: 'm', route: { kind: 'direct', chatId: '200' }, platformTime: 1 })
    expect(h.adapter.transcript).toHaveLength(0)
  })

  it('refuses a member code when another code already bound that member', async () => {
    const h = await boot({ config: { members: [member({ userId: undefined })] } })
    const codes = h.state().table('codes')
    const first = await issueCode(codes, { kind: 'member', memberId: 'alice', expiresAt: Date.now() + 60_000 })
    const second = await issueCode(codes, { kind: 'member', memberId: 'alice', expiresAt: Date.now() + 60_000 })
    await h.say('201', `/pair ${first}`)
    await h.say('202', `/pair ${second}`)
    expect(h.sent()).toEqual(['Paired as alice. Send /help for the commands.', 'That pairing code cannot be used here.'])
  })

  it('sends /ask text as a normal prompt', async () => {
    const h = await boot({ config: { members: [member()] } })
    await h.say('200', '/ask what is 2+2?')
    expect(h.client.of('session.prompt')[0]?.payload).toMatchObject({ mode: 'queue', content: [{ type: 'text', text: 'what is 2+2?' }] })
  })

  it('shows every member kind in /members and the isolation in /whoami', async () => {
    const h = await boot({
      owners: ['100'],
      config: {
        members: [
          member({ id: 'paired', userId: undefined, commands: [] }),
          member({ id: 'waiting', userId: undefined, commands: [] }),
          member({ id: 'remote', userId: '300', dshRemoteHost: '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39' }),
        ],
      },
    })
    await h.state().table('members').put('fake:500', { role: 'owner', pairedAt: 1 })
    await h.state().table('members').put('fake:501', { role: 'member', memberId: 'paired', pairedAt: 1 })
    await h.say('100', '/members')
    const lines = h.sent()[0]!.split('\n')
    expect(lines[0]).toBe('paired (fake): paired; no commands')
    expect(lines[1]).toBe('waiting (fake): not paired; no commands')
    expect(lines[2]).toContain('remote (fake): static identity;')
    await h.say('300', '/whoami')
    expect(h.sent().at(-1)).toContain('Isolation: remote host')
    await h.say('100', '/whoami')
    expect(h.sent().at(-1)).toContain('Isolation: this host')
  })
})
