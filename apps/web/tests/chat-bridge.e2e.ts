/**
 * Keyless IM chat bridge e2e, conversation half. The assembled web composition
 * runs with real Grant authentication and a replayed model; the SHIPPED
 * `dsh chat` composition (init, then a bare run) is mounted through the real
 * Loader with the fake platform in place of Telegram or Feishu. Every request
 * the bridge makes crosses the real HTTP `/api`, and every reply the fake
 * platform sees is the replayed model's answer streamed back over the real
 * `events.mux` WebSocket. No browser is involved: the bridge is itself a client.
 *
 * Scenarios: one-time owner pairing with unpaired senders ignored, unknown
 * commands refused (including `/permission`), a streamed private reply with a
 * golden transcript, duplicate deliveries answered once, Grant revocation,
 * `/stop` on a parked turn, and a presented file sent back as a platform file.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { listAuthenticationGrants, revokeAuthenticationGrant } from '@deepseek-ai/dsh-authentication-local'
import type { ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import type { FakeOutbound } from '@deepseek-ai/dsh-chat-adapter-fake'
import { mountChatWorld, OWNER_ID, scriptedOverride, STRANGER_ID, type ChatWorld } from './chat-bridge-world.ts'
import { assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/chat-bridge-conversation/im.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const REPLY_PARTS = ['LIGHT', 'HOUSE ', 'keeps ', 'watch.']

/** Write a scripted-model override into a fresh temp directory. */
async function override(turns: Parameters<typeof scriptedOverride>[0], readyFile?: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chat-e2e-override-'))
  const path = join(dir, 'replay.override.json')
  await writeFile(path, scriptedOverride(turns, readyFile))
  return { dir, path }
}

/** The last text each sent message ended with, in send order: stable however the stream was coalesced. */
function finalTranscript(transcript: readonly FakeOutbound[]): string {
  const finals = new Map<string, string>()
  for (const entry of transcript) {
    if (entry.kind === 'send' || entry.kind === 'edit') finals.set(entry.ref.messageId, entry.message.text)
  }
  return [...finals].map(([id, text]) => `- ${id}: ${JSON.stringify(text)}`).join('\n')
}

describe.skipIf(MODE === 'record')('chat bridge e2e: pairing, streaming, duplicates, revocation', () => {
  let scaffold: WebScaffold
  let world: ChatWorld
  let dir: string

  beforeAll(async () => {
    const scripted = await override([{ kind: 'text', parts: REPLY_PARTS }])
    dir = scripted.dir
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, replayOverride: scripted.path, paceMs: 20 })
    world = await mountChatWorld(scaffold)
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('hints once to an unpaired sender and refuses a wrong or reused pairing code', async () => {
    const { say, texts, ownerCode } = world
    await say(STRANGER_ID, 'hello?')
    expect(texts()).toEqual(['Send /pair <code> to join. Ask an owner for a pairing code.'])
    await say(STRANGER_ID, 'anyone there?')
    expect(texts()).toHaveLength(1)
    await say(STRANGER_ID, '/pair WRONGCODE1')
    expect(texts().at(-1)).toBe('That pairing code is not valid or has expired.')
    await say(OWNER_ID, `/pair ${ownerCode}`)
    expect(texts().at(-1)).toBe('Paired as owner. Send /help for the commands.')
    await say(STRANGER_ID, `/pair ${ownerCode}`)
    expect(texts().at(-1)).toBe('That pairing code is not valid or has expired.')
    await say(STRANGER_ID, PROMPT)
    expect(texts().at(-1)).not.toContain('LIGHTHOUSE')
  })

  it('refuses unknown commands, never forwarding them, and has no permission command', async () => {
    const { say, texts } = world
    await say(OWNER_ID, '/bogus now')
    expect(texts().at(-1)).toBe('Unknown command. Send /help for the list.')
    await say(OWNER_ID, '/permission danger-full-access')
    expect(texts().at(-1)).toBe('Unknown command. Send /help for the list.')
    await say(OWNER_ID, '/etc/passwd')
    expect(texts().at(-1)).toBe('Unknown command. Send /help for the list.')
    expect(await world.chat.harniverseClient.call('session.list', {})).toMatchObject({ items: [] })
  })

  it('streams the replayed model reply into one edited message and records a golden transcript', async () => {
    const { adapter, chat, say, texts } = world
    const before = adapter.transcript.length
    const settled = scaffold.whenTurnSettled()
    await say(OWNER_ID, PROMPT)
    await settled
    await vi.waitFor(() => { expect(texts(before).at(-1)).toBe(REPLY_PARTS.join('')) }, { timeout: 20_000 })
    const listed = await chat.harniverseClient.call('session.list', {})
    expect(listed.items).toHaveLength(1)
    const history = await chat.harniverseClient.call('session.history', { sessionId: listed.items[0]!.sessionId, afterSeq: 0, maxEvents: 200 })
    const types = history.events.map(entry => entry.event.type)
    expect(types).toContain('user/message')
    expect(types.at(-1)).toBe('turn/end')
    await compareOrRefreshGolden(GOLDEN, finalTranscript(adapter.transcript), MODE)
  })

  it('answers a repeated delivery of the same inbound message only once', async () => {
    const { adapter, texts } = world
    const before = adapter.transcript.length
    const event: ChatInbound = {
      type: 'message', messageId: 'e2e-duplicate', route: { kind: 'direct', chatId: OWNER_ID },
      sender: { userId: OWNER_ID, isBot: false }, addressed: true, text: '/whoami', controlText: '/whoami',
      attachments: [], platformTime: Date.now(),
    }
    await world.send(event)
    await world.send(event)
    expect(texts(before)).toHaveLength(1)
  })

  it('tells the user the assistant is unavailable once the Grant is revoked on the Harniverse side', async () => {
    const { adapter, say, texts, grantName } = world
    const [grant] = (await listAuthenticationGrants({ dshHome: scaffold.harnessHome })).filter(candidate => candidate.name === grantName)
    await revokeAuthenticationGrant(authenticationGrantId(grant!.id), { dshHome: scaffold.harnessHome })
    const before = adapter.transcript.length
    await say(OWNER_ID, 'a prompt after revocation')
    await vi.waitFor(() => { expect(texts(before).length).toBeGreaterThan(0) }, { timeout: 20_000 })
    expect(texts(before)).toEqual(['The assistant service is unavailable right now.'])
  })

  it('keeps the golden inventory closed', async () => {
    await assertFixtureInventory(dirname(GOLDEN), ['im.expected.md'])
  })
})

describe.skipIf(MODE === 'record')('chat bridge e2e: /stop cancels a parked turn', () => {
  let scaffold: WebScaffold
  let world: ChatWorld
  let dir: string
  let readyFile: string

  beforeAll(async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-chat-e2e-stop-'))
    readyFile = join(scratch, '.hang-ready')
    const scripted = await override([{ kind: 'hang' }], readyFile)
    dir = scripted.dir
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, replayOverride: scripted.path })
    world = await mountChatWorld(scaffold)
    await world.say(OWNER_ID, `/pair ${world.ownerCode}`)
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('stops the running turn on request and reports it was interrupted', async () => {
    const { say, texts } = world
    await say(OWNER_ID, PROMPT)
    await vi.waitFor(async () => { await stat(readyFile) }, { timeout: 20_000 })
    await say(OWNER_ID, '/stop')
    expect(texts().at(-1)).toBe('Stopping.')
    await vi.waitFor(() => { expect(texts().join('\n')).toContain('[stopped]') }, { timeout: 20_000 })
    const listed = await world.chat.harniverseClient.call('session.list', {})
    expect(listed.items[0]).toMatchObject({ running: false })
  })
})

describe.skipIf(MODE === 'record')('chat bridge e2e: a presented file comes back as a platform file', () => {
  let scaffold: WebScaffold
  let world: ChatWorld
  let dir: string

  beforeAll(async () => {
    const scripted = await override([
      { kind: 'tool', name: 'present', arguments: { files: [{ path: 'report.txt', description: 'the report' }] } },
      { kind: 'text', parts: ['Report ready.'] },
    ])
    dir = scripted.dir
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, replayOverride: scripted.path, paceMs: 5 })
    await writeFile(join(scaffold.workspaceCwd, 'report.txt'), 'quarterly numbers\n')
    // A configured owner may use the `work` alias; the file is presented from that workspace.
    world = await mountChatWorld(scaffold, { bridge: { owners: [{ platform: 'fake', userId: OWNER_ID, workspaces: ['work'] }] } })
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('sends only a file that lies inside the session workspace', async () => {
    const { adapter, say, texts } = world
    await say(OWNER_ID, '/ws work')
    expect(texts().at(-1)).not.toBe('That workspace is not available to you.')
    const settled = scaffold.whenTurnSettled()
    await say(OWNER_ID, 'Make the report and present it.')
    await settled
    await vi.waitFor(() => { expect(adapter.transcript.some(entry => entry.kind === 'file')).toBe(true) }, { timeout: 20_000 })
    const file = adapter.transcript.find((entry): entry is Extract<FakeOutbound, { kind: 'file' }> => entry.kind === 'file')!
    expect(file.file.fileName).toBe('report.txt')
    expect(file.file.bytes).toBe(Buffer.byteLength('quarterly numbers\n'))
    expect(await readFile(file.file.filePath, 'utf8')).toBe('quarterly numbers\n')
    await vi.waitFor(() => { expect(texts().at(-1)).toContain('Report ready.') }, { timeout: 20_000 })
  })
})
