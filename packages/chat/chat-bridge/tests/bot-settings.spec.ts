/** Per-bot defaults supplied through `ctx.chatBridge.useBotSettings`: they shape new owner sessions and nothing else. */

import { join } from 'node:path'
import { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import { HarniverseError } from '@deepseek-ai/dsh-chat-harniverse-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatBotSettings } from '../src/index.ts'
import { boot, cleanup, member, message, seedState, type Harness } from './helpers.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const FULL: ChatBotSettings = {
  workspace: '/srv/bot',
  agentProfile: 'bot-profile',
  model: { provider: 'p', model: 'm2', reasoningEffort: 'high' },
}

function sessionMethods(h: Harness): string[] {
  return h.client.calls.map(call => call.method).filter(method => method.startsWith('session.'))
}

describe('bot defaults for owner sessions', () => {
  it('applies workspace, Agent Preset, and model, in that order, to a new owner session', async () => {
    const h = await boot()
    const provider = vi.fn<(platform: string, botId: string) => ChatBotSettings | undefined>(() => FULL)
    h.ctx.chatBridge.useBotSettings(provider)
    await h.say('100', 'hello')
    expect(provider).toHaveBeenCalledWith('fake', 'fake-bot')
    expect(sessionMethods(h)).toEqual(['session.create', 'session.selectModelTarget', 'session.prompt'])
    const create = h.client.of('session.create')[0]!
    expect(create.payload).toMatchObject({ cwd: '/srv/bot', agentProfile: 'bot-profile' })
    const select = h.client.of('session.selectModelTarget')[0]!
    expect(select.payload).toEqual({
      sessionId: create.payload.sessionId,
      target: { kind: 'model', selection: { provider: 'p', model: 'm2', reasoningEffort: 'high' } },
    })
    expect(select.options.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
    expect(select.options.idempotencyKey).not.toBe(create.options.idempotencyKey)
    expect(h.state().table('sessions').get(String(create.payload.sessionId))).toMatchObject({ cwd: '/srv/bot', agentProfile: 'bot-profile' })
  })

  it('never writes the shared default model: only the per-session target is selected', async () => {
    const h = await boot()
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('100', 'hello')
    await h.say('100', '/new')
    expect(h.client.of('session.selectModelTarget')).toHaveLength(2)
    expect(h.client.of('session.selectModel')).toHaveLength(0)
  })

  it('selects a model without a reasoning effort and skips selection when no model is set', async () => {
    const h = await boot()
    let settings: ChatBotSettings = { model: { provider: 'p', model: 'm1' } }
    h.ctx.chatBridge.useBotSettings(() => settings)
    await h.say('100', '/new')
    settings = { workspace: '/srv/bot' }
    await h.say('100', '/new')
    expect(h.client.of('session.selectModelTarget').map(call => call.payload)).toEqual([
      { sessionId: h.client.of('session.create')[0]!.payload.sessionId, target: { kind: 'model', selection: { provider: 'p', model: 'm1' } } },
    ])
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: join(h.root, 'im', 'owner') })
    expect(h.client.of('session.create')[1]!.payload).toMatchObject({ cwd: '/srv/bot' })
  })

  it('defaults to the owner directory and no Preset when the bot has no settings', async () => {
    const h = await boot()
    h.ctx.chatBridge.useBotSettings(() => undefined)
    await h.say('100', 'hello')
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: join(h.root, 'im', 'owner') })
    expect(h.client.of('session.create')[0]!.payload).not.toHaveProperty('agentProfile')
    expect(h.client.of('session.selectModelTarget')).toHaveLength(0)
  })

  it('keeps an owner own Agent Preset and configured workspace alias ahead of the bot defaults', async () => {
    const h = await boot({
      config: {
        owners: [{ platform: 'fake', userId: '100', agentProfile: 'owner-own', workspaces: ['proj'] }],
        workspaceAliases: { proj: '/srv/proj' },
      },
    })
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('100', 'hello')
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: '/srv/proj', agentProfile: 'owner-own' })
    expect(h.client.of('session.selectModelTarget')).toHaveLength(1)
  })

  it('applies to an owner paired through a code', async () => {
    const h = await boot({ owners: [] })
    const { code } = await h.ctx.chatBridge.issueOwnerCode()
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('500', `/pair ${code}`)
    await h.say('500', 'hello')
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: '/srv/bot', agentProfile: 'bot-profile' })
  })

  it('never widens a member: members keep their own grants and directory', async () => {
    const h = await boot({ config: { members: [member({ agentProfile: 'member-profile' }), member({ id: 'bob', userId: '300' })] } })
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('200', 'hello')
    await h.say('300', 'hello')
    const [alice, bob] = h.client.of('session.create')
    expect(alice!.payload).toMatchObject({ cwd: join(h.root, 'im', 'members', 'alice'), agentProfile: 'member-profile' })
    expect(bob!.payload).toMatchObject({ cwd: join(h.root, 'im', 'members', 'bob') })
    expect(bob!.payload).not.toHaveProperty('agentProfile')
    expect(h.client.of('session.selectModelTarget')).toHaveLength(0)
    await h.say('300', '/whoami')
    expect(h.sent().at(-1)).toContain('Profile: (default)')
  })

  it('consults the settings of the bot that received the message', async () => {
    const h = await boot()
    const other = new FakeChatAdapter({ botId: 'other-bot' })
    h.ctx.chatAdapters.register(other)
    await vi.waitFor(() => { expect(other.running).toBe(true) })
    h.ctx.chatBridge.useBotSettings((_platform, botId) => botId === 'other-bot' ? { workspace: '/srv/other' } : { workspace: '/srv/first' })
    await h.say('100', 'hello')
    await other.enqueue(message('100', 'hello'))
    expect(h.client.of('session.create').map(call => call.payload.cwd)).toEqual(['/srv/first', '/srv/other'])
  })

  it('uses the first provider that has settings for the bot', async () => {
    const h = await boot()
    h.ctx.chatBridge.useBotSettings(() => undefined)
    h.ctx.chatBridge.useBotSettings(() => ({ workspace: '/srv/second' }))
    h.ctx.chatBridge.useBotSettings(() => ({ workspace: '/srv/third' }))
    await h.say('100', 'hello')
    expect(h.client.of('session.create')[0]!.payload.cwd).toBe('/srv/second')
  })

  it('stops consulting a provider once its disposer ran', async () => {
    const h = await boot()
    const dispose = h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('100', '/new')
    dispose()
    dispose()
    await h.say('100', '/new')
    const [first, second] = h.client.of('session.create')
    expect(first!.payload).toMatchObject({ cwd: '/srv/bot', agentProfile: 'bot-profile' })
    expect(second!.payload).toMatchObject({ cwd: join(h.root, 'im', 'owner') })
    expect(second!.payload).not.toHaveProperty('agentProfile')
    expect(h.client.of('session.selectModelTarget')).toHaveLength(1)
  })

  it('disposing one provider leaves an identical function registered twice working for the other registration', async () => {
    const h = await boot()
    const provider = (): ChatBotSettings => FULL
    const first = h.ctx.chatBridge.useBotSettings(provider)
    h.ctx.chatBridge.useBotSettings(provider)
    first()
    await h.say('100', 'hello')
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: '/srv/bot' })
  })
})

describe('invalid or failing bot defaults', () => {
  it('ignores a relative workspace with a warning and falls back to the owner directory', async () => {
    const h = await boot()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    h.ctx.chatBridge.useBotSettings(() => ({ workspace: 'relative/dir', agentProfile: 'bot-profile' }))
    await h.say('100', 'hello')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not an absolute path'))
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ cwd: join(h.root, 'im', 'owner'), agentProfile: 'bot-profile' })
  })

  it('keeps the session and the prompt when the model cannot be selected', async () => {
    const h = await boot()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    h.client.on('session.selectModelTarget', () => { throw new HarniverseError('rpc-rejected', 'x', { rpcCode: 'model-not-allowed' }) })
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('100', 'hello')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('default model'))
    expect(h.client.of('session.prompt')).toHaveLength(1)
    expect(h.state().table('sessions').size).toBe(1)
    expect(h.sent()).toEqual([])
  })

  it('rolls back only when session.create itself fails, never selecting a model', async () => {
    const h = await boot()
    h.client.on('session.create', () => { throw new HarniverseError('transport-failed', 'down') })
    h.ctx.chatBridge.useBotSettings(() => FULL)
    await h.say('100', 'hello')
    expect(h.client.of('session.selectModelTarget')).toHaveLength(0)
    expect(h.state().table('sessions').size).toBe(0)
  })
})

describe('changing bot defaults while a conversation is bound', () => {
  it('keeps an owner session created under earlier defaults and applies new ones only to later sessions', async () => {
    const h = await boot()
    await h.say('100', 'before any settings')
    let settings: ChatBotSettings = { agentProfile: 'profile-one' }
    h.ctx.chatBridge.useBotSettings(() => settings)
    await h.say('100', 'with the first settings')
    expect(h.client.of('session.create')).toHaveLength(1)
    await h.say('100', '/new')
    expect(h.client.of('session.create')).toHaveLength(2)
    settings = { agentProfile: 'profile-two' }
    await h.say('100', 'with the second settings')
    expect(h.client.of('session.create')).toHaveLength(2)
    await h.say('100', '/new')
    expect(h.client.of('session.create').map(call => call.payload.agentProfile)).toEqual([undefined, 'profile-one', 'profile-two'])
  })

  it('still starts a new session for an owner whose configured Preset differs from the session', async () => {
    const root = await seedState(async (state) => {
      await state.table('sessions').put('chat-old', {
        sessionId: 'chat-old', ownerKey: 'fake:100', botId: 'fake-bot', platform: 'fake',
        route: { kind: 'direct', chatId: '100' }, cwd: '/x', createdAt: 1, agentProfile: 'stale',
      })
      await state.table('bindings').put('fake-bot:direct:100', { sessionId: 'chat-old' })
    })
    const h = await boot({
      root,
      config: { owners: [{ platform: 'fake', userId: '100', agentProfile: 'owner-own', workspaces: [] }] },
    })
    h.ctx.chatBridge.useBotSettings(() => ({ agentProfile: 'bot-profile' }))
    await h.say('100', 'hello')
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ agentProfile: 'owner-own' })
  })

  it('shows the effective Preset in /whoami and accepts it in /new', async () => {
    const h = await boot()
    await h.say('100', '/whoami')
    h.ctx.chatBridge.useBotSettings(() => ({ agentProfile: 'bot-profile' }))
    await h.say('100', '/whoami')
    await h.say('100', '/new other')
    await h.say('100', '/new bot-profile')
    expect(h.sent()[0]).toContain('Profile: (default)')
    expect(h.sent()[1]).toContain('Profile: bot-profile')
    expect(h.sent()[2]).toBe('That profile is not available to you.')
    expect(h.sent()[3]).toMatch(/^Started a new session/)
    expect(h.client.of('session.create')[0]!.payload).toMatchObject({ agentProfile: 'bot-profile' })
  })
})
