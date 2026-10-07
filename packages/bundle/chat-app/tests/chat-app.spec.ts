/** The chat profile through the real Loader: the shipped patch over an isolated Harness home, driven by `provideCmdline`. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { createAuthenticationClientGrant, listAuthenticationGrants, revokeAuthenticationGrant } from '@deepseek-ai/dsh-authentication-local'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import ChatAdapters from '@deepseek-ai/dsh-chat-adapter'
import * as FakePlugin from '@deepseek-ai/dsh-chat-adapter-fake'
import type { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import * as TelegramPlugin from '@deepseek-ai/dsh-chat-adapter-telegram'
import * as FeishuPlugin from '@deepseek-ai/dsh-chat-adapter-feishu'
import * as BridgePlugin from '@deepseek-ai/dsh-chat-bridge'
import HarniverseClient from '@deepseek-ai/dsh-chat-harniverse-client'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Runner from '../src/index.ts'
import * as Startup from '../src/startup.ts'

const PATCH = new URL('../cordis.patch.yml', import.meta.url)
const directories: string[] = []
const originalHome = process.env.DSH_HOME

beforeEach(() => {
  Runner.internals.fetch = globalThis.fetch.bind(globalThis)
  Runner.internals.createGrant = createAuthenticationClientGrant
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  Runner.internals.stdout = process.stdout
  Runner.internals.stderr = process.stderr
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

function publicKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

/** A home whose Harniverse has an owner device, which `init` requires. */
async function homeWithOwner(): Promise<string> {
  const home = await temporary('dsh-chat-app-home-')
  await createAuthenticationClientGrant({
    name: 'owner', publicKey: publicKey(),
    capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
  }, { dshHome: home })
  return home
}

interface Boot {
  ctx: Context
  code: number
  out: string
  err: string
}

const MODULES = (extra: Record<string, unknown> = {}): Map<string, unknown> => new Map<string, unknown>([
  ['@deepseek-ai/dsh-chat-app/startup', Startup],
  ['@deepseek-ai/dsh-chat-app', Runner],
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
  ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
  ['@deepseek-ai/dsh-chat-harniverse-client', HarniverseClient],
  ['@deepseek-ai/dsh-chat-adapter-telegram', TelegramPlugin],
  ['@deepseek-ai/dsh-chat-adapter-feishu', FeishuPlugin],
  ['@deepseek-ai/dsh-chat-bridge', BridgePlugin],
  ['@deepseek-ai/dsh-chat-adapter-fake', FakePlugin],
  ...Object.entries(extra),
])

/** Mount the shipped patch over an empty root with `args` as the command line. */
async function mount(
  args: string[],
  home: string,
  extraPatches: unknown[] = [],
  extraModules: Record<string, unknown> = {},
): Promise<{ ctx: Context; exited: Promise<number>; capture: () => { out: string; err: string } }> {
  process.env.DSH_HOME = home
  let out = ''
  let err = ''
  const stdout = { write: (chunk: string) => { out += chunk; return true } }
  const stderr = { write: (chunk: string) => { err += chunk; return true } }
  cmdlineInternals.stdout = stdout
  cmdlineInternals.stderr = stderr
  Runner.internals.stdout = stdout
  Runner.internals.stderr = stderr
  const root = await temporary('dsh-chat-app-root-')
  await writeFile(join(root, 'cordis.yml'), '[]\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('dshHomePath', dshHomePath)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = MODULES(extraModules)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const exited = new Promise<number>((resolve) => { provideCmdline(ctx, { args, exit: resolve }) })
  const patches = [...loadOverlayPatches('chat-app test', fileURLToPath(PATCH)), ...extraPatches]
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href, patches } })
  await ctx.loader.await()
  return { ctx, exited, capture: () => ({ out, err }) }
}

/** Run a one-shot operation to completion. */
async function invoke(args: string[], home: string, extraPatches: unknown[] = []): Promise<Boot> {
  const { ctx, exited, capture } = await mount(args, home, extraPatches)
  const code = await exited
  const { out, err } = capture()
  await ctx.fiber.dispose()
  return { ctx, code, out, err }
}

async function credentialsOf(home: string): Promise<string> {
  return readFile(join(home, 'chat-bridge', 'credentials.yaml'), 'utf8')
}

function ownerCode(out: string): string {
  return /pairing code \(valid 15 minutes\): ([0-9A-Z]{5}-[0-9A-Z]{5})/.exec(out)![1]!
}

describe('dsh chat init', () => {
  it('creates the key, registers the Grant, writes a template, and prints an owner code', async () => {
    const home = await homeWithOwner()
    const result = await invoke(['init'], home)
    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toContain('signing key: created (DSH_CHAT_BRIDGE_SIGNING)')
    expect(result.out).toContain('grant: registered')
    expect(result.out).toContain(`config: wrote a template to ${join(resolveProfileDir('chat', home), 'patch.yml')}`)
    const grants = await listAuthenticationGrants({ dshHome: home })
    const grant = grants.find(candidate => candidate.name === 'chat-bridge')!
    expect(grant).toMatchObject({ kind: 'api-client', capabilities: ['harniverse.observe', 'harniverse.operate'] })
    const credentials = await credentialsOf(home)
    expect(credentials).toContain(`DSH_CHAT_BRIDGE_GRANT_ID: ${grant.id}`)
    expect(credentials).toContain('DSH_CHAT_BRIDGE_SIGNING:')
    expect((await stat(join(home, 'chat-bridge', 'credentials.yaml'))).mode & 0o077).toBe(0)
    expect(await readFile(join(resolveProfileDir('chat', home), 'patch.yml'), 'utf8')).toContain('- id: chat-bridge')
    expect(ownerCode(result.out)).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
  })

  it('is idempotent: it reuses the key and Grant, keeps an edited patch, and issues another code', async () => {
    const home = await homeWithOwner()
    const first = await invoke(['init'], home)
    const patchPath = join(resolveProfileDir('chat', home), 'patch.yml')
    await writeFile(patchPath, '- id: chat-bridge\n  config:\n    owners: [{ platform: fake, userId: "1" }]\n')
    const second = await invoke(['init'], home)
    expect(second).toMatchObject({ code: 0, err: '' })
    expect(second.out).toContain('signing key: reused')
    expect(second.out).toContain('grant: reused')
    expect(second.out).toContain(`config: kept ${patchPath}`)
    expect(ownerCode(second.out)).not.toBe(ownerCode(first.out))
    expect((await listAuthenticationGrants({ dshHome: home })).filter(grant => grant.name.startsWith('chat-bridge'))).toHaveLength(1)
    expect(await readFile(patchPath, 'utf8')).toContain('userId: "1"')
    await writeFile(patchPath, '# notes\n[]\n')
    expect((await invoke(['init'], home)).out).toContain('wrote a template to')
    await writeFile(patchPath, '   \n')
    expect((await invoke(['init'], home)).out).toContain('wrote a template to')
  })

  it('tells the person to finish the browser login when Harniverse has no owner yet', async () => {
    const home = await temporary('dsh-chat-app-home-')
    const result = await invoke(['init'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain('Harniverse has no owner yet')
    expect(result.err).toContain('dsh chat init')
  })

  it('refuses a Grant that does not match the stored key and a stored key that is not P-256', async () => {
    const home = await homeWithOwner()
    await invoke(['init'], home)
    const credentials = await credentialsOf(home)
    await writeFile(join(home, 'chat-bridge', 'credentials.yaml'), credentials.replace(/DSH_CHAT_BRIDGE_SIGNING: .*/, () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
      return `DSH_CHAT_BRIDGE_SIGNING: ${other}`
    }), { mode: 0o600 })
    const mismatch = await invoke(['init'], home)
    expect(mismatch.code).toBe(1)
    expect(mismatch.err).toContain('does not match the stored signing key; run `dsh chat rotate-key`')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
    await writeFile(join(home, 'chat-bridge', 'credentials.yaml'), credentials.replace(/DSH_CHAT_BRIDGE_SIGNING: .*/, `DSH_CHAT_BRIDGE_SIGNING: ${rsa}`), { mode: 0o600 })
    const wrongCurve = await invoke(['init'], home)
    expect(wrongCurve.err).toContain('is not a P-256 key')
  })

  it('registers under a suffixed name when the stored Grant is gone and its name is taken', async () => {
    const home = await homeWithOwner()
    await invoke(['init'], home)
    const original = (await listAuthenticationGrants({ dshHome: home })).find(grant => grant.name === 'chat-bridge')!
    await revokeAuthenticationGrant(authenticationGrantId(original.id), { dshHome: home })
    await createAuthenticationClientGrant({ name: 'chat-bridge', publicKey: publicKey(), capabilities: ['harniverse.observe'] }, { dshHome: home })
    const result = await invoke(['init'], home)
    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toMatch(/grant: registered \S+ \(chat-bridge-\d{14},/)
  })

  it('surfaces other registration failures unchanged', async () => {
    const home = await homeWithOwner()
    Runner.internals.createGrant = () => Promise.reject(new Error('registry is read-only'))
    const result = await invoke(['init'], home)
    expect(result).toMatchObject({ code: 1, out: '', err: 'dsh: registry is read-only\n' })
  })

  it('reports a corrupt Grant registry', async () => {
    const home = await homeWithOwner()
    await writeFile(join(home, 'auth', 'grants.json'), '{not json')
    const result = await invoke(['init'], home)
    expect(result.code).toBe(1)
    expect(result.err.length).toBeGreaterThan('dsh: '.length)
  })

  it('falls back to DSH_HOME when the runner row carries no dshHome', async () => {
    const home = await homeWithOwner()
    const bare = (operation: string): unknown[] => [{ id: 'chat-runner', config: { operation } }]
    const init = await invoke(['init'], home, bare('init'))
    expect(init).toMatchObject({ code: 0, err: '' })
    expect(init.out).toContain(join(home, 'profiles', 'chat', 'patch.yml'))
    expect(await listAuthenticationGrants({ dshHome: home })).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'chat-bridge' })]))
    const rotated = await invoke(['rotate-key'], home, bare('rotate-key'))
    expect(rotated).toMatchObject({ code: 0, err: '' })
    expect(rotated.out).toContain('old grant: revoked')
    Runner.internals.fetch = () => Promise.reject(new Error('down'))
    const status = await invoke(['status'], home, bare('status'))
    expect(status.out).toContain('harniverse http://127.0.0.1:3080: unreachable (down)')
  })
})

describe('dsh chat rotate-key', () => {
  it('replaces the key and Grant and revokes the old Grant', async () => {
    const home = await homeWithOwner()
    await invoke(['init'], home)
    const before = await credentialsOf(home)
    const old = (await listAuthenticationGrants({ dshHome: home })).find(grant => grant.name === 'chat-bridge')!
    const result = await invoke(['rotate-key'], home)
    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toContain('signing key: replaced')
    expect(result.out).toContain(`old grant: revoked ${old.id}`)
    const after = await credentialsOf(home)
    expect(after).not.toBe(before)
    const grants = await listAuthenticationGrants({ dshHome: home })
    expect(grants.some(grant => grant.id === old.id)).toBe(false)
    const fresh = grants.find(grant => /^chat-bridge-\d{14}$/.test(grant.name))!
    expect(after).toContain(`DSH_CHAT_BRIDGE_GRANT_ID: ${fresh.id}`)
    expect((await invoke(['init'], home)).out).toContain('grant: reused')
  })

  it('refuses before init and tolerates an old Grant that is already gone', async () => {
    const home = await homeWithOwner()
    const early = await invoke(['rotate-key'], home)
    expect(early.code).toBe(1)
    expect(early.err).toContain('nothing to rotate')
    await invoke(['init'], home)
    const old = (await listAuthenticationGrants({ dshHome: home })).find(grant => grant.name === 'chat-bridge')!
    await revokeAuthenticationGrant(authenticationGrantId(old.id), { dshHome: home })
    expect((await invoke(['rotate-key'], home)).out).toContain('old grant: already gone')
  })
})

describe('dsh chat status', () => {
  it('reports missing pieces before init without changing anything', async () => {
    const home = await homeWithOwner()
    Runner.internals.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'))
    const before = JSON.stringify(await listAuthenticationGrants({ dshHome: home }))
    const result = await invoke(['status'], home)
    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toContain('signing key: missing')
    expect(result.out).toContain('grant: missing')
    expect(result.out).toContain('harniverse http://127.0.0.1:3080: unreachable (connect ECONNREFUSED)')
    expect(result.out).toContain('state: 0 paired identities, 0 sessions, 0 groups')
    expect(JSON.stringify(await listAuthenticationGrants({ dshHome: home }))).toBe(before)
  })

  it('reports an initialized profile and a reachable Harniverse', async () => {
    const home = await homeWithOwner()
    await invoke(['init'], home)
    const credentials = await credentialsOf(home)
    const requested: string[] = []
    Runner.internals.fetch = (input) => { requested.push(input instanceof Request ? input.url : input.toString()); return Promise.resolve(Response.json({ mode: 'authenticated', sealed: true })) }
    const result = await invoke(['status', '--origin', 'http://127.0.0.1:4000'], home)
    expect(result.out).toContain('signing key: present')
    expect(result.out).toMatch(/grant: \S+ \(chat-bridge, harniverse.observe,harniverse.operate\) active/)
    expect(result.out).toContain('harniverse http://127.0.0.1:4000: reachable, authentication authenticated')
    expect(requested).toEqual(['http://127.0.0.1:4000/auth/status'])
    expect(await credentialsOf(home)).toBe(credentials)
    Runner.internals.fetch = () => Promise.resolve(Response.json({}))
    expect((await invoke(['status'], home)).out).toContain('authentication unknown')
    Runner.internals.fetch = () => Promise.reject('plain failure') // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    expect((await invoke(['status'], home)).out).toContain('unreachable (plain failure)')
  })

  it('reports an expired Grant', async () => {
    const home = await homeWithOwner()
    await invoke(['init'], home)
    const grantsPath = join(home, 'auth', 'grants.json')
    const registry = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: Array<{ name: string; createdAt: string; expiresAt?: string }> }
    const grant = registry.grants.find(candidate => candidate.name === 'chat-bridge')!
    // The registry rejects an expiry that precedes creation, so age both.
    grant.createdAt = '1999-01-01T00:00:00.000Z'
    grant.expiresAt = '2000-01-01T00:00:00.000Z'
    await writeFile(grantsPath, JSON.stringify(registry))
    Runner.internals.fetch = () => Promise.reject(new Error('down'))
    expect((await invoke(['status'], home)).out).toContain('expired')
  })
})

describe('dsh chat run', () => {
  it('serves a bridge over the shipped rows: an owner code from init pairs an owner and the bridge answers', async () => {
    const home = await homeWithOwner()
    const init = await invoke(['init'], home)
    const { FakeClient } = await import('../../../chat/chat-bridge/tests/fixtures/fake-client.ts')
    const client = new FakeClient()
    const { ctx, capture } = await mount(['run'], home, [
      { id: 'chat-client', disabled: true },
      { id: 'chat-bridge', config: { streamIntervalMs: 0 } },
      { insert: [
        { id: 'test-client', name: 'test-harniverse-client' },
        { id: 'chat-fake', name: '@deepseek-ai/dsh-chat-adapter-fake', config: { platform: 'fake', botId: 'run-bot' } },
      ] },
    ], { 'test-harniverse-client': { name: 'test-harniverse-client', apply: (c: Context) => { c.provide('harniverseClient', client.asClient()) } } })
    try {
      expect(capture().out).toContain('the bridge is running')
      const adapter = ctx.chatAdapters.get('fake', 'run-bot') as FakeChatAdapter
      await vi.waitFor(() => { expect(adapter.running).toBe(true) })
      const say = (text: string, id: string): Promise<void> => adapter.enqueue({
        type: 'message', messageId: id, route: { kind: 'direct', chatId: '42' }, sender: { userId: '42', isBot: false },
        addressed: true, text, controlText: text, attachments: [], platformTime: 1,
      })
      await say('/help', 'm0')
      await say(`/pair ${ownerCode(init.out)}`, 'm1')
      await say('/help', 'm2')
      const texts = adapter.transcript.flatMap(entry => entry.kind === 'send' ? [entry.message.text] : [])
      expect(texts[0]).toContain('Send /pair <code> to join')
      expect(texts[1]).toBe('Paired as owner. Send /help for the commands.')
      expect(texts[2]).toContain('/invite <member>')
      expect(ctx.chatAdapters.list().map(entry => `${entry.platform}:${entry.botId}`)).toEqual(['fake:run-bot'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not mount the bridge, client, adapters, or runner side effects for one-shot operations', async () => {
    const home = await homeWithOwner()
    const { ctx, exited } = await mount(['status'], home)
    Runner.internals.fetch = () => Promise.reject(new Error('down'))
    await exited
    expect(ctx.get('chatAdapters')).toBeUndefined()
    expect(ctx.get('harniverseClient')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('command line', () => {
  async function operation(args: string[], home: string): Promise<Record<string, unknown>> {
    const { ctx, exited } = await mount(args, home)
    Runner.internals.fetch = () => Promise.reject(new Error('down'))
    const values = { ...ctx.get('chatStartup') as Record<string, unknown> }
    await Promise.race([exited, Promise.resolve(0)])
    await ctx.fiber.dispose()
    return values
  }

  it('runs by default, by name, and selects maintenance operations', async () => {
    const home = await homeWithOwner()
    expect(await operation([], home)).toEqual({ operation: 'run' })
    expect(await operation(['run'], home)).toEqual({ operation: 'run' })
    expect(await operation(['status', '--origin', 'http://127.0.0.1:1'], home)).toEqual({ operation: 'status', origin: 'http://127.0.0.1:1' })
  })

  it('prints help without mounting the bridge', async () => {
    const home = await homeWithOwner()
    const { ctx, exited, capture } = await mount(['--help'], home)
    expect(await exited).toBe(0)
    expect(capture().out).toContain('rotate-key')
    expect(capture().out).toContain('init')
    await ctx.fiber.dispose()
  })

  it('bridges every startup field into the runner row of the shipped patch', async () => {
    const home = await homeWithOwner()
    const fields = new Set<string>()
    for (const args of [[], ['status']]) {
      const values = await operation(args, home)
      for (const key of Object.keys(values)) fields.add(key)
    }
    const shipped = await readFile(PATCH, 'utf8')
    const runnerRow = shipped.slice(shipped.indexOf('id: chat-runner'))
    for (const field of fields) expect(runnerRow, `cordis.patch.yml must bridge chatStartup.${field} into the runner row`).toContain(`!!js ctx.chatStartup.${field}`)
    expect(fields).toContain('origin')
  })
})

describe('runner without a Loader', () => {
  const config = { operation: 'status' } as const

  it('refuses a one-shot operation when the launcher provided no exit request', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(() =>{  Runner.apply(ctx, config) }).toThrow('the launcher must provide ctx.appExit')
  })

  it('reports a rejection that is not an Error and exits non-zero', async () => {
    const codes: number[] = []
    let err = ''
    Runner.internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const ctx = {
      get: () => (code: number) => { codes.push(code) },
      credentials: { resolve: () => Promise.reject('plain failure') }, // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    } as unknown as Context
    Runner.apply(ctx, config)
    await vi.waitFor(() => { expect(codes).toEqual([1]) })
    expect(err).toBe('dsh: plain failure\n')
  })
})
