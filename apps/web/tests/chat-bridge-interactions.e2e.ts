/**
 * Keyless IM chat bridge e2e, interaction half. A read-only session asked to
 * write a file produces a REAL pending approval on the assembled web
 * composition, and the replayed `ask_user_question` tool produces a REAL
 * pending question. The bridge routes both to the owner through the fake
 * platform, and the answer travels back over the signed `POST /api/respond`.
 *
 * Scenarios: a member's approval goes only to the owner, the member cannot
 * answer it, and the owner's button press lets the turn finish; an unanswered
 * approval is rejected after its timeout and the turn still ends; a question
 * is answered with `/answer`. The permission preset is switched by the test
 * through the Harniverse command surface, the way the owner's browser would:
 * the chat bridge itself has no permission command.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OWNER_ID, MEMBER_ID, mountChatWorld, type ChatWorld } from './chat-bridge-world.ts'
import { fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()
const APPROVAL_FIXTURE = fileURLToPath(new URL('./snapshots/approval-composer/session.jsonl', import.meta.url))
const QUESTION_FIXTURE = fileURLToPath(new URL('./snapshots/question-composer/session.jsonl', import.meta.url))

// Mirrors approval-composer.e2e.ts: the replayed request must carry this exact text.
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
const WRITE_PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`

const BRIDGE = {
  owners: [{ platform: 'fake', userId: OWNER_ID, workspaces: ['work'] }],
  members: [{ id: 'alice', platform: 'fake', userId: MEMBER_ID, commands: ['new', 'ask', 'stop'], workspaces: ['work'] }],
}

/** Every event the Harniverse recorded for `sessionId`, across history pages. */
async function sessionEvents(world: ChatWorld, sessionId: string): Promise<Array<{ type: string; seq: number; data: unknown }>> {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  for (let afterSeq = 0; ;) {
    const page = await world.chat.harniverseClient.call('session.history', { sessionId, afterSeq, maxEvents: 200 })
    events.push(...page.events.map(entry => entry.event))
    if (!page.hasMore || page.events.length === 0) return events
    afterSeq = page.events.at(-1)!.event.seq
  }
}

/** Open a session for the member, then confine it to read-only so the write escalates to an approval. */
async function readOnlyMemberSession(world: ChatWorld): Promise<string> {
  await world.say(MEMBER_ID, '/ws work')
  await world.say(MEMBER_ID, '/new')
  await vi.waitFor(() => { expect(world.textsFor(MEMBER_ID).at(-1)).toContain('session') }, { timeout: 20_000 })
  const listed = await world.chat.harniverseClient.call('session.list', {})
  expect(listed.items).toHaveLength(1)
  const sessionId = listed.items[0]!.sessionId
  await world.chat.harniverseClient.typert('commands/execute', { agentId: sessionId, line: '/permission read-only', images: [] })
  return sessionId
}

describe.skipIf(MODE === 'record')('chat bridge e2e: a member\'s approval goes to the owner', () => {
  let scaffold: WebScaffold
  let world: ChatWorld

  beforeAll(async () => {
    expect(fixtureUserPrompts(await readFile(APPROVAL_FIXTURE, 'utf8'))).toEqual([WRITE_PROMPT])
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: APPROVAL_FIXTURE, paceMs: 15 })
    world = await mountChatWorld(scaffold, { bridge: BRIDGE })
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
  })

  it('forwards the card only to the owner, ignores the member\'s answer, and finishes after the owner approves', async () => {
    const { say, click, interactions, textsFor } = world
    const sessionId = await readOnlyMemberSession(world)
    const settled = scaffold.whenTurnSettled(60_000)
    await say(MEMBER_ID, WRITE_PROMPT)
    await vi.waitFor(() => { expect(interactions()).toHaveLength(1) }, { timeout: 60_000 })
    const [card] = interactions()
    expect(card!.route).toMatchObject({ kind: 'direct', chatId: OWNER_ID })
    expect(card!.prompt.kind).toBe('approval')
    expect(card!.prompt.body).toContain('requested by alice')
    expect(card!.prompt.actions.map(action => action.label)).toEqual(['Approve once', 'Reject'])
    await vi.waitFor(() => { expect(textsFor(MEMBER_ID).at(-1)).toBe('The tool request was forwarded to the owner for approval.') }, { timeout: 20_000 })

    // The member presses the owner's button: refused, and nothing was decided on the Harniverse side.
    await click(MEMBER_ID, card!.prompt.actions[0]!.id)
    expect(textsFor(MEMBER_ID).at(-1)).toBe('You cannot answer this request.')
    expect((await sessionEvents(world, sessionId)).filter(event => event.type === 'approval/decided')).toHaveLength(0)

    await click(OWNER_ID, card!.prompt.actions[0]!.id)
    expect(textsFor(OWNER_ID).at(-1)).toBe('Approved once.')
    await settled
    await vi.waitFor(() => { expect(textsFor(MEMBER_ID).at(-1)).toContain('DONE') }, { timeout: 20_000 })
    expect(world.adapter.transcript.some(entry => entry.kind === 'settle' && entry.state === 'answered')).toBe(true)

    const decided = (await sessionEvents(world, sessionId)).filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(JSON.stringify(decided[0])).toContain('allowed-once')
  }, 180_000)
})

describe.skipIf(MODE === 'record')('chat bridge e2e: an unanswered approval is rejected after its timeout', () => {
  let scaffold: WebScaffold
  let world: ChatWorld

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: APPROVAL_FIXTURE, paceMs: 15 })
    world = await mountChatWorld(scaffold, { bridge: { ...BRIDGE, approvalTimeoutMs: 1_500 } })
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
  })

  it('answers the request as rejected, tells the member, and lets the turn end', async () => {
    const { say, textsFor } = world
    const sessionId = await readOnlyMemberSession(world)
    const settled = scaffold.whenTurnSettled(60_000)
    await say(MEMBER_ID, WRITE_PROMPT)
    await vi.waitFor(() => { expect(textsFor(MEMBER_ID).join('\n')).toContain('The tool request timed out and was rejected.') }, { timeout: 60_000 })
    await settled
    expect(world.adapter.transcript.some(entry => entry.kind === 'settle' && entry.state === 'expired')).toBe(true)
    const decided = (await sessionEvents(world, sessionId)).filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(JSON.stringify(decided[0])).toContain('rejected')
  }, 180_000)
})

describe.skipIf(MODE === 'record')('chat bridge e2e: a question is answered from the chat', () => {
  let scaffold: WebScaffold
  let world: ChatWorld
  let prompt: string

  beforeAll(async () => {
    const prompts = fixtureUserPrompts(await readFile(QUESTION_FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    prompt = prompts[0]!
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: QUESTION_FIXTURE, paceMs: 15 })
    world = await mountChatWorld(scaffold, { bridge: BRIDGE })
  }, 120_000)

  afterAll(async () => {
    await world?.close()
    await scaffold?.close()
  })

  it('posts the question to the asker and resumes the turn with the typed answer', async () => {
    const { say, textsFor } = world
    const settled = scaffold.whenTurnSettled(60_000)
    await say(OWNER_ID, prompt)
    let id = ''
    await vi.waitFor(() => {
      const body = textsFor(OWNER_ID).find(text => text.includes('Which color do you prefer?'))
      expect(body).toBeDefined()
      id = /\/answer (\S+) /.exec(body!)![1]!
    }, { timeout: 60_000 })
    await say(OWNER_ID, `/answer ${id} 1`)
    expect(textsFor(OWNER_ID).at(-1)).toBe('Answer sent.')
    await settled
    await vi.waitFor(() => { expect(textsFor(OWNER_ID).at(-1)).toContain('DONE') }, { timeout: 20_000 })
  }, 180_000)
})
