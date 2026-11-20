/** Peer pairing management through the real startup/runner Loader composition. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import * as Authentication from '@deepseek-ai/dsh-authentication-local'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as RemoteHostSsh from '@deepseek-ai/dsh-remote-hosts-ssh'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import PeerOutboxService from '@deepseek-ai/dsh-peer-outbox'
import { createAuthenticationClientGrant, issueEnrollmentInvitation } from '@deepseek-ai/dsh-authentication-local'
import { ensureInstanceIdentity, readInstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'
import type { InstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'
import * as PeerHost from '@deepseek-ai/dsh-peer-host'
import { apply as applyRunner, internals as runnerInternals } from '../src/index.ts'
import { apply as applyStartup } from '../src/startup.ts'
import type { RemoteHostSshProvider } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  runnerInternals.stdout = process.stdout
  runnerInternals.stderr = process.stderr
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

interface InvocationResult { code: number; out: string; err: string }

/** Boot the two production plugins through Loader; a stub remote-hosts-ssh satisfies the runner injection. */
async function invoke(args: string[], dshHome: string, overrides: Record<string, object> = {}): Promise<InvocationResult> {
  const fixture = await temporary('dsh-peer-app-loader-')
  const fields = ['operation', 'uri', 'endpoint', 'displayName', 'ttl', 'fingerprint', 'sshHost', 'instanceId', 'timeoutMs', 'prompt', 'sessionId', 'cwd', 'profile', 'messageId', 'surface', 'async']
  await writeFile(join(fixture, 'cordis.yml'), [
    '- id: remote-hosts-ssh',
    '  name: remote-hosts-ssh',
    '- id: storage',
    '  name: storage',
    '- id: storage-json',
    '  name: storage-json',
    '  config:',
    `    root: ${JSON.stringify(join(dshHome, 'storages'))}`,
    '- id: storage-domain',
    '  name: storage-domain',
    '  config:',
    '    backend: json',
    '- id: peer-runner',
    '  name: peer-runner',
    '  inject: [peerStartup, remoteHostSsh, storageDomain]',
    '  config:',
    ...fields.map(field => `    ${field}: !!js ctx.peerStartup.${field}`),
    `    dshHome: ${JSON.stringify(dshHome)}`,
    '- id: peer-startup',
    '  name: peer-startup',
    '',
  ].join('\n'))
  let out = ''
  let err = ''
  const stdout = { write: (chunk: string) => { out += chunk; return true } }
  const stderr = { write: (chunk: string) => { err += chunk; return true } }
  cmdlineInternals.stdout = stdout
  cmdlineInternals.stderr = stderr
  runnerInternals.stdout = stdout
  runnerInternals.stderr = stderr
  const modules: Record<string, object> = {
    'remote-hosts-ssh': RemoteHostSsh,
    storage: { default: Storage },
    'storage-json': StorageJson,
    'storage-domain': StorageDomain,
    'peer-startup': { name: 'peer-startup', inject: ['cmdlineArgs'], apply: applyStartup },
    'peer-runner': { name: 'peer-runner', inject: ['peerStartup', 'remoteHostSsh'], apply: applyRunner },
    ...overrides,
  }
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(fixture).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const module = modules[specifier]
    if (!module) throw new Error(`unknown fixture module ${specifier}`)
    return module
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const exited = new Promise<number>((resolve) => { provideCmdline(ctx, { args, exit: resolve }) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(fixture, 'cordis.yml')).href } })
  await ctx.loader.await()
  const code = await exited
  return { code, out, err }
}

/** One freshly issued invitation payload against a bootstrapped target. */
type TargetInvite = () => Promise<{ token: string }>

/** The accepting side booted once, with its origin, home, identity, and invitation mint. */
interface ServingTarget {
  origin: string
  home: string
  identity: InstanceIdentity
  invite: TargetInvite
}

/** A deterministic agent registry standing in for the real loop in CLI e2e runs. */
class SettlingAgentRegistry extends Service {
  /** Created entries by session id. */
  readonly entries = new Map<string, { status: 'idle' | 'running'; followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => void; whenIdle: () => Promise<void>; session: { id: string; seq: number; events: Array<{ type: string; seq: number; data: unknown }>; eventsFrom: (from: number) => Array<{ type: string; data: unknown }> } }>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(id: string) {
    return this.entries.get(id)
  }

  async create(options: { sessionId: string; meta: { cwd: string; origin?: string }; setup: (ctx: Context) => Promise<void> }) {
    const events: Array<{ type: string; seq: number; data: unknown }> = []
    const session = {
      id: options.sessionId,
      events,
      get seq() { return events.length },
      eventsFrom: (from: number) => events.filter(event => event.seq >= from),
    }
    let idle: Promise<void> = Promise.resolve()
    let settle: (() => void) | undefined
    const entry = {
      status: 'idle' as 'idle' | 'running',
      session,
      whenIdle: () => idle,
      cancel: (cause: { kind: string }) => {
        if (settle === undefined) return
        const turn = 1 + events.filter(event => event.type === 'turn/end').length
        events.push({ type: 'turn/end', seq: events.length, data: { turn, reason: { kind: cause.kind } } })
        entry.status = 'idle'
        settle()
      },
      followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
        const prompt = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
        entry.status = 'running'
        const turn = 1 + events.filter(event => event.type === 'turn/end').length
        events.push({ type: 'turn/start', seq: events.length, data: { turn } })
        events.push({ type: 'user/message', seq: events.length, data: message })
        idle = new Promise((resolve) => {
          const timer = setTimeout(() => {
            settle = undefined
            events.push({ type: 'assistant/message', seq: events.length, data: { turn, step: 1, message: { content: [{ type: 'text', text: `echo: ${prompt}` }] } } })
            events.push({ type: 'turn/end', seq: events.length, data: { turn, reason: { kind: 'completed' } } })
            entry.status = 'idle'
            resolve()
          }, prompt.startsWith('hold') ? 10_000 : 10)
          settle = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      },
    }
    this.entries.set(options.sessionId, entry)
    return { agent: entry }
  }

  async resume(options: { resumeSessionId: string }) {
    if (!this.entries.has(options.resumeSessionId)) throw new Error('no persisted session')
    return { agent: this.entries.get(options.resumeSessionId)! }
  }

  async closeIfIdle(id: string) {
    return this.entries.delete(id) ? 'closed' : 'not-found'
  }
}

/** Boot the accepting stack once and expose its origin plus a bootstrapped owner. */
async function servingTarget(): Promise<ServingTarget> {
  const home = await temporary('peer-app-target-')
  const identity = await ensureInstanceIdentity(home)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { id: 'authentication', name: 'authentication', config: { dshHome: home, watch: false } },
    { id: 'webserver', name: 'webserver', inject: ['authentication'], config: { host: '127.0.0.1', port: 0 } },
    { id: 'peer-host', name: 'peer-host', config: { dshHome: home } },
    { id: 'agents', name: 'agents' },
    { id: 'typert', name: 'typert' },
    { id: 'gateway', name: 'gateway' },
    { id: 'connection', name: 'connection' },
  ]))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const modules: Record<string, object> = {
      authentication: Authentication, webserver: WebServer, 'peer-host': PeerHost,
      agents: { default: SettlingAgentRegistry },
      typert: Typert, gateway: Gateway, connection: Connection,
    }
    const module = modules[specifier]
    if (!module) throw new Error(`unknown fixture module ${specifier}`)
    return module
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  await createAuthenticationClientGrant({ name: 'owner', publicKey, capabilities: ['harniverse.authorize'] }, { dshHome: home })
  const invite: TargetInvite = async () => {
    const invitation = await issueEnrollmentInvitation({ capabilities: ['harniverse.peer'], kind: 'peer', ttlMs: 60_000 }, { dshHome: home })
    return { token: invitation.token }
  }
  return { origin, home, identity, invite }
}

/** Extract the accepted message id from one async submission's receipt line. */
function submittedMessageId(out: string): string {
  const line = out.split('\n').find(entry => entry.startsWith('receipt\t'))!
  return line.split('\t')[2]!
}

/** Extract the URI line the invite command printed. */
function inviteUri(out: string): string {
  const line = out.split('\n').find(entry => entry.startsWith('dsh-peer://'))
  if (line === undefined) throw new Error(`no invitation URI in output: ${out}`)
  return line
}

it('invites and pairs two homes end to end through the CLI composition', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--name', 'Build workstation', '--ttl', '600000'], target.home)
  expect(invited.code).toBe(0)
  const uri = inviteUri(invited.out)
  const initiator = await temporary('peer-app-initiator-')
  const added = await invoke(['add', uri, '--timeout', '20000'], initiator)
  expect(added.code).toBe(0)
  expect(added.out).toContain('paired\t')
  const listed = await invoke(['list'], target.home)
  expect(listed.out).toContain((await readInstanceIdentity(initiator)).instanceId)
  const targets = await invoke(['targets'], initiator)
  expect(targets.out).toContain(target.identity.instanceId)
  const removed = await invoke(['remove', (await readInstanceIdentity(initiator)).instanceId], target.home)
  expect(removed.code).toBe(0)
  expect((await readFile(join(target.home, 'peers.json'), 'utf8'))).not.toContain((await readInstanceIdentity(initiator)).instanceId)
  const forgotten = await invoke(['forget', target.identity.instanceId], initiator)
  expect(forgotten.code).toBe(0)
  expect(await readFile(join(initiator, 'peer-targets.json'), 'utf8')).toContain('"targets":[]')
})

it('runs, sends, and lists delegated sessions through the CLI composition', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--ttl', '600000'], target.home)
  const uri = inviteUri(invited.out)
  const initiator = await temporary('peer-app-initiator-')
  const added = await invoke(['add', uri, '--timeout', '20000'], initiator)
  expect(added.code).toBe(0)
  const targetId = target.identity.instanceId
  const run = await invoke(['run', targetId, 'summarize', 'the', 'tree', '--timeout', '10000'], initiator)
  expect(run.code).toBe(0)
  expect(run.out).toContain('session\t')
  expect(run.out).toContain('echo: summarize the tree')
  const sessionId = run.out.split('\n')[0]!.split('\t')[1]!
  const sessions = await invoke(['sessions', targetId], initiator)
  expect(sessions.code).toBe(0)
  expect(sessions.out).toContain(sessionId)
  expect(sessions.out).toContain('summarize the tree')
  const sent = await invoke(['send', targetId, sessionId, 'thanks', '--timeout', '10000'], initiator)
  expect(sent.code).toBe(0)
  expect(sent.out).toContain('echo: thanks')
  const unknown = await invoke(['run', '01234567-89ab-cdef-0123-456789abcdef', 'nope'], initiator)
  expect(unknown.code).toBe(1)
  expect(unknown.err).toContain('RECORD_NOT_FOUND')
})

it('runs delegated sessions with options, budgets, and continued turns', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--ttl', '600000'], target.home)
  const uri = inviteUri(invited.out)
  const initiator = await temporary('peer-app-initiator-')
  await invoke(['add', uri, '--timeout', '20000'], initiator)
  const targetId = target.identity.instanceId
  const withOptions = await invoke(['run', targetId, 'summarize', 'the', 'tree', '--cwd', 'repo/src', '--profile', 'none'], initiator)
  expect(withOptions.code).toBe(0)
  expect(withOptions.out).toContain('echo: summarize the tree')
  const running = await invoke(['run', targetId, 'still', 'working', '--timeout', '1'], initiator)
  expect(running.code).toBe(0)
  expect(running.out).toContain('running')
  expect(running.out).not.toContain('echo:')
  const sessionId = running.out.split('\n')[0]!.split('\t')[1]!
  const resumed = await invoke(['send', targetId, sessionId, 'thanks', '--timeout', '10000'], initiator)
  expect(resumed.code).toBe(0)
  expect(resumed.out).toContain('echo: thanks')
  const defaultBudget = await invoke(['send', targetId, sessionId, 'again'], initiator)
  expect(defaultBudget.code).toBe(0)
  expect(defaultBudget.out).toContain('echo: again')
})

it('issues a pinned invitation whose URI carries the TLS fingerprint', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', 'https://build.example.org:8443', '--ttl', '600000', '--fingerprint', 'A'.repeat(43)], target.home)
  expect(invited.code, `invite stderr: ${invited.err}`).toBe(0)
  const payload = JSON.parse(Buffer.from(inviteUri(invited.out).slice('dsh-peer://'.length), 'base64url').toString('utf8')) as { tlsFingerprint?: string; endpoint: { origin: string } }
  expect(payload.tlsFingerprint).toBe('A'.repeat(43))
  expect(payload.endpoint.origin).toBe('https://build.example.org:8443')
})

it('cancels the current turn of an async-submitted session', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--ttl', '600000'], target.home)
  const uri = inviteUri(invited.out)
  const initiator = await temporary('peer-app-initiator-')
  await invoke(['add', uri, '--timeout', '20000'], initiator)
  const targetId = target.identity.instanceId
  const submitted = await invoke(['run', targetId, 'hold', 'still', '--async'], initiator)
  expect(submitted.out).toContain('running')
  const sessionLine = submitted.out.split('\n').find(entry => entry.startsWith('session\t'))!
  const sessionId = sessionLine.split('\t')[1]!
  const cancelled = await invoke(['cancel', targetId, sessionId], initiator)
  expect(cancelled.code, `cancel stderr: ${cancelled.err}`).toBe(0)
  expect(cancelled.out).toContain('settled')
  expect(cancelled.out).toContain('user')
  const settledRead = await invoke(['result', targetId, sessionId, submittedMessageId(submitted.out)], initiator)
  expect(settledRead.out).toContain('user')
})

it('requests surface changes through the CLI composition', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--ttl', '600000'], target.home)
  expect(invited.code).toBe(0)
  const initiator = await temporary('peer-app-surface-')
  const added = await invoke(['add', inviteUri(invited.out), '--timeout', '20000'], initiator)
  expect(added.code, `add stderr: ${added.err}`).toBe(0)
  const targetId = target.identity.instanceId
  const narrowed = await invoke(['surface', targetId, '--delegate', 'on', '--message', 'off', '--list', 'off'], initiator)
  expect(narrowed.code, `surface stderr: ${narrowed.err}`).toBe(0)
  expect(narrowed.out).toContain('committed (delegate, no-message, no-list)')
  const parked = await invoke(['surface', targetId, '--delegate', 'on', '--message', 'on', '--list', 'off'], initiator)
  expect(parked.code, `surface stderr: ${parked.err}`).toBe(0)
  expect(parked.out).toContain('pending owner approval (current: delegate, no-message, no-list)')
  const badFlag = await invoke(['surface', targetId, '--delegate', 'maybe', '--message', 'on', '--list', 'on'], initiator)
  expect(badFlag.code).toBe(1)
  expect(badFlag.err).toContain('take "on" or "off"')
})

it('rejects an invalid lifetime and prints help for a bare command', async () => {
  const home = await temporary('peer-app-ttl-')
  const badTtl = await invoke(['invite', '--endpoint', 'https://build.example.org:8443', '--ttl', 'abc'], home)
  expect(badTtl.code).toBe(1)
  expect(badTtl.err).toContain('--ttl accepts')
  const badFingerprint = await invoke(['invite', '--endpoint', 'https://build.example.org:8443', '--fingerprint', 'short'], home)
  expect(badFingerprint.code).toBe(1)
  expect(badFingerprint.err).toContain('--fingerprint must be base64 SHA-256 (43 characters)')
  const help = await invoke([], home)
  expect(help.code).toBe(0)
  expect(help.out).toContain('Manage instance pairing')
})

it('submits asynchronously, reads the settlement later, and lists the ledger', async () => {
  const target = await servingTarget()
  const invited = await invoke(['invite', '--endpoint', target.origin, '--ttl', '600000'], target.home)
  const uri = inviteUri(invited.out)
  const initiator = await temporary('peer-app-initiator-')
  await invoke(['add', uri, '--timeout', '20000'], initiator)
  const targetId = target.identity.instanceId
  const submitted = await invoke(['run', targetId, 'slow', 'job', '--async'], initiator)
  expect(submitted.code).toBe(0)
  expect(submitted.out).toContain('running')
  expect(submitted.out).toContain('receipt\t')
  const sessionLine = submitted.out.split('\n').find(entry => entry.startsWith('session\t'))!
  const receiptLine = submitted.out.split('\n').find(entry => entry.startsWith('receipt\t'))!
  const sessionId = sessionLine.split('\t')[1]!
  const messageId = receiptLine.split('\t')[2]!
  const read = await invoke(['result', targetId, sessionId, messageId], initiator)
  expect(read.code).toBe(0)
  expect(read.out).toContain('settled')
  expect(read.out).toContain('echo: slow job')

  const empty = await invoke(['outbox'], initiator)
  expect(empty.code, `empty outbox stderr: ${empty.err}`).toBe(0)
  expect(empty.out).not.toContain('watching')

  const asyncSend = await invoke(['send', targetId, sessionId, 'second', '--async'], initiator)
  expect(asyncSend.code).toBe(0)
  expect(asyncSend.out).toContain('running')
  expect(asyncSend.out).toContain('receipt\t')
  const sendReceipt = asyncSend.out.split('\n').find(entry => entry.startsWith('receipt\t'))!
  const sendMessageId = sendReceipt.split('\t')[2]!
  const sendRead = await invoke(['result', targetId, sessionId, sendMessageId], initiator)
  expect(sendRead.out).toContain('echo: second')

  const seed = new Context()
  contexts.push(seed)
  seed.provide('agents', { get: () => undefined } as never)
  seed.provide('sessions', { flush: async () => undefined } as never)
  await seed.plugin(Storage)
  await seed.plugin(StorageJson, { root: join(initiator, 'storages') })
  await seed.plugin(StorageDomain, { backend: 'json' })
  await seed.plugin(PeerOutboxService, { dshHome: initiator, pollIntervalMs: 60_000 })
  await seed.peerOutbox.track({
    targetInstanceId: targetId,
    targetDisplayName: 'Workstation',
    peerSessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
    messageId: 'm-seed',
    ownerSessionId: 'owner-session',
    label: 'seeded watch',
  })
  await seed.peerOutbox.track({
    targetInstanceId: targetId,
    targetDisplayName: 'Workstation',
    peerSessionId: 'peer-01234567-89ab-cdef-0123-456789aaaa',
    messageId: 'm-seed-2',
    ownerSessionId: 'owner-session',
    label: 'seeded watch 2',
  })
  await seed.fiber.dispose()
  contexts.pop()
  const ledger = await invoke(['outbox'], initiator)
  expect(ledger.code, `outbox stderr: ${ledger.err}`).toBe(0)
  expect(ledger.out).toContain('watching')
  expect(ledger.out).toContain('seeded watch')
})

it('rejects an invalid endpoint, a bad fingerprint, an unknown SSH host, and a malformed URI', async () => {
  const home = await temporary('peer-app-home-')
  const badEndpoint = await invoke(['invite', '--endpoint', 'http://build.example.org:80'], home)
  expect(badEndpoint.code).toBe(1)
  expect(badEndpoint.err).toContain('INVALID_PAYLOAD')
  const target = await servingTarget()
  const badPin = await invoke(['invite', '--endpoint', target.origin.replace('http', 'https'), '--fingerprint', 'short'], target.home)
  expect(badPin.code).toBe(1)
  expect(badPin.err).toContain('fingerprint')
  const sshHome = await temporary('peer-app-ssh-')
  const targetIdentity = await ensureInstanceIdentity(sshHome)
  const addUnknown = await invoke(['add', `dsh-peer://${Buffer.from(JSON.stringify({
    version: 1, instanceId: targetIdentity.instanceId, displayName: 'x',
    endpoint: { origin: 'http://127.0.0.1:9' }, token: `dshi1_${'A'.repeat(27)}`,
  })).toString('base64url')}`, '--ssh-host', 'missing'], sshHome)
  expect(addUnknown.code).toBe(1)
  expect(addUnknown.err).toContain('no remote host named')
  const malformed = await invoke(['add', 'not-a-uri'], home)
  expect(malformed.code).toBe(1)
  expect(malformed.err).toContain('INVALID_URI')
  const noHome = await invoke(['list'], home)
  expect(noHome.code).toBe(0)
})

it('rejects unknown ids on remove and forget, and removes a grant-less record', async () => {
  const target = await servingTarget()
  const initiator = await temporary('peer-app-initiator-')
  const missing = await invoke(['remove', '99999999-1111-4222-8333-999999999999'], target.home)
  expect(missing.code).toBe(1)
  expect(missing.err).toContain('RECORD_NOT_FOUND')
  const forgotten = await invoke(['forget', '99999999-1111-4222-8333-999999999999'], initiator)
  expect(forgotten.code).toBe(1)
  expect(forgotten.err).toContain('RECORD_NOT_FOUND')
  const crafted = await temporary('peer-app-crafted-')
  const craftedIdentity = await ensureInstanceIdentity(crafted)
  await ensureInstanceIdentity(target.home)
  await writeFile(join(target.home, 'peers.json'), JSON.stringify({ version: 1, peers: [{
    instanceId: craftedIdentity.instanceId, displayName: 'Crafted', platform: 'linux', arch: 'x64', version: '1',
    surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
    firstSeenAt: '2026-11-18T08:00:00.000Z', lastSeenAt: '2026-11-18T08:00:00.000Z',
  }] }))
  const grantless = await invoke(['remove', craftedIdentity.instanceId], target.home)
  expect(grantless.code).toBe(0)
})

it('covers the direct runner paths for missing fields and default lifetimes', async () => {
  const { Context: RawContext } = await import('@deepseek-ai/cordis')
  const { provideCmdline: provide } = await import('@deepseek-ai/dsh-cmdline')
  const { apply } = await import('../src/index.ts')
  const home = await temporary('peer-app-direct-')
  const invokeDirect = async (config: Record<string, unknown>): Promise<{ code: number; err: string }> => {
    const ctx = new RawContext()
    const exits: number[] = []
    const captured: string[] = []
    runnerInternals.stderr = { write: (chunk: string) => { captured.push(chunk); return true } }
    provide(ctx, { args: [], exit: (code: number) => { exits.push(code) } })
    apply(ctx, config as never)
    await expect.poll(() => exits.length, { timeout: 5_000 }).toBeGreaterThan(0)
    await ctx.fiber.dispose()
    runnerInternals.stderr = process.stderr
    return { code: exits[0] ?? -1, err: captured.join('') }
  }
  const missingField = await invokeDirect({ operation: 'invite', dshHome: home })
  expect(missingField.code).toBe(1)
  expect(missingField.err).toContain('requires --endpoint')
  const defaultTtl = await invokeDirect({ operation: 'invite', dshHome: home, endpoint: 'https://build.example.org:8443' })
  expect(defaultTtl.code).toBe(1)
  expect(defaultTtl.err).toContain('first active Grant')
  await writeFile(join(home, 'peer-targets.json'), JSON.stringify({
    version: 1,
    targets: [{
      targetInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
      displayName: 'Unreachable', endpoint: { origin: 'http://127.0.0.1:1' },
      transport: { kind: 'direct' }, grantName: 'peer-3f2a8f9e-1111-4222-8333-444455556666',
      grantId: 'gone', status: 'active', addedAt: '2026-01-01T00:00:00.000Z',
    }],
  }))
  const sendWithoutBudget = await invokeDirect({
    operation: 'send', dshHome: home,
    instanceId: '3f2a8f9e-1111-4222-8333-444455556666',
    sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
    prompt: 'p',
  })
  expect(sendWithoutBudget.code).toBe(1)
  expect(sendWithoutBudget.err).not.toContain('RECORD_NOT_FOUND')
  const runWithoutBudget = await invokeDirect({
    operation: 'run', dshHome: home,
    instanceId: '3f2a8f9e-1111-4222-8333-444455556666',
    prompt: 'p',
  })
  expect(runWithoutBudget.code).toBe(1)
  expect(runWithoutBudget.err).not.toContain('RECORD_NOT_FOUND')
})

it('pairs through a stubbed SSH forward to a live target', async () => {
  const target = await servingTarget()
  const registryHome = await temporary('peer-app-tunnel-')
  const identity = await ensureInstanceIdentity(registryHome)
  const { generateKeyPairSync } = await import('node:crypto')
  const keyPem: string = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const keyPath = join(registryHome, 'id_ecdsa')
  await writeFile(keyPath, keyPem)
  const fingerprint = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`
  await writeFile(join(registryHome, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    hosts: [{
      id: '44444444-4444-4444-8444-444444444444', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
      fingerprint, platform: 'linux', architecture: 'x64',
      authentication: { kind: 'key', keyPath }, reverseMappings: [],
    }],
  }))
  const forwards: number[] = []
  const disposals: number[] = []
  class Ssh extends Service {
    open: RemoteHostSshProvider['open'] = async () => ({
      signal: new AbortController().signal,
      forward: async () => {
        const port = Number(new URL(target.origin).port)
        forwards.push(port)
        return { port, close: async () => {} }
      },
      dispose: async () => { disposals.push(1) },
    }) as never
    verify: RemoteHostSshProvider['verify'] = async () => { throw new Error('unused') }
    constructor(context: Context) { super(context, 'remoteHostSsh') }
  }
  const agentHost = {
    id: '44444444-4444-4444-8444-444444444444', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
    fingerprint, platform: 'linux', architecture: 'x64',
    authentication: { kind: 'agent', socket: '/run/agent.sock' }, reverseMappings: [],
  }
  await writeFile(join(registryHome, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    hosts: [agentHost, {
      id: '45454545-4545-4455-8455-454545454545', name: 'keybox', host: 'keybox.invalid', port: 22, username: 'runner',
      fingerprint, platform: 'linux', architecture: 'x64',
      authentication: { kind: 'key', keyPath }, reverseMappings: [],
    }],
  }))
  const overrides = { 'remote-hosts-ssh': { default: Ssh } }
  const agentAdded = await invoke(['add', `dsh-peer://${Buffer.from(JSON.stringify({
    version: 1, instanceId: target.identity.instanceId, displayName: target.identity.displayName,
    endpoint: { origin: 'http://127.0.0.1:9' }, token: (await target.invite()).token,
  })).toString('base64url')}`, '--ssh-host', 'box', '--timeout', '20000'], registryHome, overrides)
  expect(agentAdded.code).toBe(0)
  const tunneled = await invoke(['run', target.identity.instanceId, 'through', 'the', 'tunnel', '--timeout', '10000'], registryHome, overrides)
  expect(tunneled.code).toBe(0)
  expect(tunneled.out).toContain('echo: through the tunnel')

  const uri = `dsh-peer://${Buffer.from(JSON.stringify({
    version: 1, instanceId: target.identity.instanceId, displayName: target.identity.displayName,
    endpoint: { origin: 'http://127.0.0.1:9' }, token: (await target.invite()).token,
  })).toString('base64url')}`
  void identity
  const added = await invoke(['add', uri, '--ssh-host', 'keybox', '--timeout', '20000'], registryHome, { 'remote-hosts-ssh': { default: Ssh } })
  expect(added.code).toBe(0)
  expect(added.out).toContain('paired\t')
  expect(forwards).toEqual([Number(new URL(target.origin).port), Number(new URL(target.origin).port), Number(new URL(target.origin).port)])
  expect(await readFile(join(registryHome, 'peer-targets.json'), 'utf8')).toContain('"kind":"ssh"')
})

it('rejects a localhost invitation endpoint behind --ssh-host and a runner without appExit', async () => {
  const home = await temporary('peer-app-localhost-')
  const identity = await ensureInstanceIdentity(home)
  const fingerprint = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`
  await writeFile(join(home, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    hosts: [{
      id: '55555555-5555-4555-8555-555555555555', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
      fingerprint, platform: 'linux', architecture: 'x64',
      authentication: { kind: 'agent', socket: '/run/agent.sock' }, reverseMappings: [],
    }],
  }))
  const uri = `dsh-peer://${Buffer.from(JSON.stringify({
    version: 1, instanceId: identity.instanceId, displayName: 'x',
    endpoint: { origin: 'http://localhost:9' }, token: `dshi1_${'A'.repeat(27)}`,
  })).toString('base64url')}`
  const localhost = await invoke(['add', uri, '--ssh-host', 'box', '--timeout', '500'], home)
  expect(localhost.code).toBe(1)
  expect(localhost.err).toContain('ssh targets require a loopback')
  const secure = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(uri.slice('dsh-peer://'.length), 'base64url').toString('utf8')), endpoint: { origin: 'https://build.example.org:8443' } })).toString('base64url')
  const tlsUri = `dsh-peer://${secure}`
  const httpsEndpoint = await invoke(['add', tlsUri, '--ssh-host', 'box', '--timeout', '500'], home)
  expect(httpsEndpoint.code).toBe(1)
  expect(httpsEndpoint.err).toContain('ssh targets require a loopback')
  const { Context: RawContext } = await import('@deepseek-ai/cordis')
  const { apply } = await import('../src/index.ts')
  const bare = new RawContext()
  expect(() => { apply(bare, { operation: 'list', dshHome: home }) }).toThrow(/appExit/)
  await bare.fiber.dispose()
})

it('maps agent and encrypted host logins onto closed credential rejections', async () => {
  const home = await temporary('peer-app-map-')
  const observations: string[] = []
  class Ssh extends Service {
    open: RemoteHostSshProvider['open'] = async () => { observations.push('open'); throw new Error('unused') }
    verify: RemoteHostSshProvider['verify'] = async () => { throw new Error('unused') }
    constructor(context: Context) { super(context, 'remoteHostSsh') }
  }
  const registryHome = await temporary('peer-app-registry-')
  const fingerprint = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`
  await writeFile(join(registryHome, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    hosts: [{
      id: '22222222-2222-4222-8222-222222222222', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
      fingerprint, platform: 'linux', architecture: 'x64',
      authentication: { kind: 'password', passwordRef: 'box_password' }, reverseMappings: [],
    }, {
      id: '33333333-3333-4333-8333-333333333333', name: 'agentbox', host: 'agentbox.invalid', port: 22, username: 'runner',
      fingerprint, platform: 'linux', architecture: 'x64',
      authentication: { kind: 'agent', socket: '/run/agent.sock' }, reverseMappings: [],
    }],
  }))
  const identity = await ensureInstanceIdentity(home)
  const uri = `dsh-peer://${Buffer.from(JSON.stringify({
    version: 1, instanceId: identity.instanceId, displayName: 'x',
    endpoint: { origin: 'http://127.0.0.1:9' }, token: `dshi1_${'A'.repeat(27)}`,
  })).toString('base64url')}`
  const passwordRef = await invoke(['add', uri, '--ssh-host', 'box', '--timeout', '500'], registryHome, { 'remote-hosts-ssh': { default: Ssh } })
  expect(passwordRef.code).toBe(1)
  expect(passwordRef.err).toContain('UNSUPPORTED_CREDENTIALS')
  const httpsUri = `dsh-peer://${Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(uri.slice('dsh-peer://'.length), 'base64url').toString('utf8')) as object,
    endpoint: { origin: 'https://box.invalid:9' },
  })).toString('base64url')}`
  const https = await invoke(['add', httpsUri, '--ssh-host', 'agentbox'], registryHome, { 'remote-hosts-ssh': { default: Ssh } })
  expect(https.code).toBe(1)
  expect(https.err).toContain('ssh targets require a loopback')
  expect(observations).toEqual([])
})
