/**
 * Real Loader composition: the real web server, authentication provider,
 * credentials, storage domain, adapter registry, Telegram provider, and the
 * manager, with the real embedded bridge and its real HTTP client. Only the
 * Telegram Bot API and the business endpoints behind `/api` are scripted. A
 * model round trip needs the whole agent stack and belongs to the web e2e.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthenticationLocal, { listAuthenticationGrants } from '@deepseek-ai/dsh-authentication-local'
import ChatAdapters from '@deepseek-ai/dsh-chat-adapter'
import * as Telegram from '@deepseek-ai/dsh-chat-adapter-telegram'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import ChatManager from '../src/index.ts'
import { ScriptedBotApi } from './fixtures/bot-api.ts'
import { carrier, carrierCalls } from './fixtures/carrier.ts'
import { seedOwner } from './fixtures/owner.ts'

const TOKEN = '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const original = Telegram.internals.fetch

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  Telegram.internals.fetch = original
  carrierCalls.length = 0
  await context?.fiber.dispose()
  context = undefined
  // A provider still unwinding can write under the home while it is removed (observed once as ENOTEMPTY), so the removal retries.
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
})

/** Boot the rows the web composition mounts for chat, over a temp home. */
async function load(options: { seedOwner?: boolean; reuseRoot?: boolean } = {}): Promise<{ ctx: Context; home: string }> {
  const base = options.reuseRoot === true && root !== undefined ? root : await mkdtemp(join(tmpdir(), 'dsh-chat-manager-loader-'))
  root = base
  const home = join(base, 'home')
  if (options.seedOwner !== false) await seedOwner(home, 'e2e-owner')
  const configPath = join(base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(home, '.credentials.yaml'))}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-authentication-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(home)}`,
    '    mode: authenticated',
    '    debounceMs: 20',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- name: test-carrier',
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-chat-adapter'",
    "- name: '@deepseek-ai/dsh-chat-adapter-telegram'",
    '  config:',
    '    bots: []',
    "- name: '@deepseek-ai/dsh-chat-manager'",
    '  config:',
    `    dshHome: ${JSON.stringify(home)}`,
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(base).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-authentication-local', AuthenticationLocal],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['test-carrier', carrier],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
    ['@deepseek-ai/dsh-chat-adapter-telegram', Telegram],
    ['@deepseek-ai/dsh-chat-manager', ChatManager],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, home }
}

/** A private Telegram text from the user `1001`. */
function privateText(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 1001, is_bot: false, first_name: 'Dana' },
      chat: { id: 1001, type: 'private', first_name: 'Dana' },
      date: 1_700_000_000,
      text,
    },
  }
}

const signal = (): AbortSignal => new AbortController().signal

describe('real Loader composition', () => {
  it('adds a Telegram bot, brings it online, pairs an owner, and relays the owner\'s first prompt through the real bridge and HTTP client', async () => {
    const telegram = new ScriptedBotApi()
    Telegram.internals.fetch = telegram.fetch
    const { ctx, home } = await load()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const manager = ctx.chatManager

    expect(await manager.snapshot()).toMatchObject({
      platforms: [{ platform: 'telegram', label: 'Telegram', fields: [{ key: 'token', secret: true }, { key: 'baseUrl', secret: false }] }],
      bots: [],
      owners: [],
      bridge: 'stopped',
    })

    // addBot: one scripted getMe, the secret into the credential store, the bridge and the bot started.
    const bot = await manager.addBot({ platform: 'telegram', values: { token: TOKEN } }, signal())
    expect(bot).toMatchObject({
      platform: 'telegram', alias: 'Harni', identity: { botId: '777000', displayName: 'Harni' },
      values: {}, secrets: { token: { configured: true, tail: 'AAAA' } }, enabled: true,
    })
    expect(telegram.calls[0]).toMatchObject({ method: 'getMe' })
    await vi.waitFor(async () => { expect((await manager.snapshot()).bots[0]?.state).toBe('online') })
    expect((await manager.snapshot()).bridge).toBe('running')
    expect(ctx.chatAdapters.get('telegram', '777000')).toBeDefined()

    // The Grant the manager provisioned is what the real authentication provider verifies below.
    const grants = (await listAuthenticationGrants({ dshHome: home })).filter(grant => grant.name === 'chat-bridge')
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ kind: 'api-client', capabilities: ['harniverse.observe', 'harniverse.operate'] })
    expect(await ctx.credentials.resolve('DSH_CHAT_BRIDGE_GRANT_ID' as never)).toMatchObject({ value: grants[0]!.id })

    // Defaults for the owner's new sessions, set live, without restarting the bot.
    const workspace = join(home, 'owner-workspace')
    await manager.updateBot({ id: bot.id, settings: { workspace, agentProfile: 'bot-profile' } })

    // issueOwnerCode → a scripted /pair update binds the owner.
    const { code, expiresAt } = await manager.issueOwnerCode()
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/u)
    expect(expiresAt).toBeGreaterThan(Date.now())
    telegram.pending(privateText(2001, `/pair ${code}`))
    await vi.waitFor(async () => { expect((await manager.snapshot()).owners).toHaveLength(1) })
    expect((await manager.snapshot()).owners[0]).toMatchObject({ key: 'telegram:1001', platform: 'telegram', userId: '1001', displayName: 'Dana' })
    await vi.waitFor(() => { expect(telegram.of('sendMessage').at(-1)?.payload.text).toContain('Paired as owner') })

    // An owner message creates a session and is accepted as a prompt over real HTTP, authenticated by the provisioned Grant.
    telegram.pending(privateText(2002, 'hello from telegram'))
    await vi.waitFor(() => { expect(carrierCalls.map(call => call.method)).toContain('session.prompt') })
    const create = carrierCalls.find(call => call.method === 'session.create')
    expect(create?.payload).toMatchObject({ cwd: workspace, agentProfile: 'bot-profile' })
    expect(carrierCalls.find(call => call.method === 'session.prompt')?.payload).toMatchObject({ sessionId: create?.payload.sessionId })

    // Unpairing the owner removes the binding.
    expect(await manager.unpairOwner({ key: 'telegram:1001' })).toBe(true)
    expect((await manager.snapshot()).owners).toEqual([])

    // The secret appears in no response and not in the registry file.
    const registry = await readFile(join(home, 'chat-bots.json'), 'utf8')
    expect(registry + JSON.stringify([bot, await manager.snapshot()])).not.toContain(TOKEN.split(':')[1])

    // Removing the only bot stops the bridge and deletes the credential.
    await manager.removeBot({ id: bot.id })
    expect(ctx.chatAdapters.list()).toEqual([])
    expect(ctx.get('chatBridge')).toBeUndefined()
    expect(await manager.snapshot()).toMatchObject({ bots: [], bridge: 'stopped' })
    expect(await ctx.credentials.resolve(`DSH_CHAT_BOT_${bot.id.toUpperCase()}_TOKEN` as never)).toBeUndefined()
  }, 30_000)

  it('refuses a non-http(s) Bot API address and a rejected token without registering anything', async () => {
    const telegram = new ScriptedBotApi()
    Telegram.internals.fetch = telegram.fetch
    const { ctx } = await load()
    await expect(ctx.chatManager.addBot({ platform: 'telegram', values: { token: TOKEN, baseUrl: 'ftp://proxy.example/' } }, signal()))
      .rejects.toMatchObject({ code: 'chat-bot-failed', details: { reason: 'invalid-input' } })
    await expect(ctx.chatManager.addBot({ platform: 'telegram', values: { token: 'not-a-token' } }, signal()))
      .rejects.toMatchObject({ code: 'chat-bot-failed', details: { reason: 'invalid-credentials' } })
    expect(telegram.calls).toEqual([])
    expect(await ctx.chatManager.snapshot()).toMatchObject({ bots: [], bridge: 'stopped' })
  })

  it('restarts the registered bots with the host and reuses the provisioned Grant', async () => {
    const telegram = new ScriptedBotApi()
    Telegram.internals.fetch = telegram.fetch
    const first = await load()
    const bot = await first.ctx.chatManager.addBot({ platform: 'telegram', values: { token: TOKEN } }, signal())
    const [grant] = (await listAuthenticationGrants({ dshHome: first.home })).filter(candidate => candidate.name === 'chat-bridge')
    await first.ctx.fiber.dispose()
    context = undefined

    // A second host over the same home: the registry, credentials, and Grant carry over.
    const second = await load({ seedOwner: false, reuseRoot: true })
    await vi.waitFor(async () => { expect((await second.ctx.chatManager.snapshot()).bots[0]?.state).toBe('online') })
    expect((await second.ctx.chatManager.snapshot()).bots.map(entry => entry.id)).toEqual([bot.id])
    expect(await listAuthenticationGrants({ dshHome: second.home }).then(grants => grants.filter(candidate => candidate.name.startsWith('chat-bridge')).map(candidate => candidate.id))).toEqual([grant!.id])
    expect(await second.ctx.credentials.resolve('DSH_CHAT_BRIDGE_GRANT_ID' as never)).toMatchObject({ value: grant!.id })
  }, 30_000)
})
