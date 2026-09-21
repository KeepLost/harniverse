/** Keyless assembled-Web evidence for scheduler-driven conversational delivery. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, conversationContextKey, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./schedule-after.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/schedule-after', import.meta.url))
const AFTER_EXPECTED = join(SNAPSHOT_DIR, 'conversation.expected.md')
const AT_EXPECTED = join(SNAPSHOT_DIR, 'at-conversation.expected.md')
const EVERY_EXPECTED = join(SNAPSHOT_DIR, 'every-conversation.expected.md')
const AFTER_PROVIDER = 'schedule-after-web-test'
const AT_PROVIDER = 'schedule-at-web-test'
const EVERY_PROVIDER = 'schedule-every-web-test'
const MODEL = 'reply'
const AFTER_PROMPT = 'Check the deployment log'
const AFTER_REPLY = 'Reminder: Check the deployment log.'
const AT_BROWSER_ZONE = 'Asia/Shanghai'
const AT_USER_PROMPT = 'Remind me to review the release window in a few seconds in my local time.'
const AT_PROMPT = 'Review the release window'
const AT_READY = 'Ready for a browser-local reminder request.'
const AT_ACK = 'Scheduled in your browser time zone.'
const AT_REPLY = 'Reminder: Review the release window.'
const EVERY_PRIMARY_PROMPT = 'Check primary metrics'
const EVERY_SECONDARY_PROMPT = 'Check secondary metrics'
const EVERY_REPLY_PRIMARY = 'Reminder: Check primary metrics.'
const EVERY_REPLY_SECONDARY = 'Reminder: Check secondary metrics.'
const EVERY_INTERVAL_MS = 5 * 60_000
const EVERY_PRIMARY_AGE_MS = 90 * 60_000
const EVERY_SECONDARY_DELAY_MS = 6_000

/** Emit one complete assistant text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Deterministic model seam that turns one due delivery into ordinary assistant prose. */
class ReminderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reply: string) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * textResponse(this.reply)
  }
}

/** Deterministic model seam mapping each delivered schedule prompt to its own reply. */
class EveryPromptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: Map<string, string>) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const deliveries = options.messages.filter(message => (
      message.source.kind === 'plugin' && message.source.plugin === 'schedule'
    ))
    const latest = deliveries.at(-1)
    const prompt = [...this.replies.keys()].find(key => (
      latest?.content.some(block => block.type === 'text' && block.text.includes(key))
    ))
    if (prompt === undefined) throw new Error('no delivered schedule prompt matched a scripted reply')
    yield * textResponse(this.replies.get(prompt) ?? '')
  }
}

interface LocalAt {
  readonly date: string
  readonly time: string
  readonly offset: string
}

/** Render one future epoch as exact local calendar fields with a normalized UTC offset. */
function localAt(epoch: number, timeZone: string): LocalAt {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(epoch).map(part => [part.type, part.value])) as Record<string, string>
  const offset = (parts['timeZoneName'] ?? 'GMT+00:00').replace(/^GMT/, '')
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}:${parts['second']}`,
    offset: offset === '' || offset === '+00:00' ? 'Z' : offset,
  }
}

/** Dynamic model seam proving request-local browser context becomes an explicit run_at. */
class BrowserZoneAtAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  selectedRunAt: string | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield * textResponse(AT_READY)
      return
    }
    if (this.requests.length === 2) {
      const target = Math.ceil((Date.now() + 5_000) / 1_000) * 1_000
      const local = localAt(target, AT_BROWSER_ZONE)
      this.selectedRunAt = local.offset === 'Z' ? `${local.date}T${local.time}Z` : `${local.date}T${local.time}${local.offset}`
      const argumentsJson = JSON.stringify({ prompt: AT_PROMPT, run_at: this.selectedRunAt })
      const callId = CallId('schedule-at-browser-zone')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: 'schedule_create',
        argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: 'schedule_create',
          arguments: argumentsJson,
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield * textResponse(this.requests.length === 3 ? AT_ACK : AT_REPLY)
  }
}

/** Extract text from one durable assistant message. */
function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Extract all model-visible text from one assembled request. */
function requestText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** The plugin-sourced scheduler deliveries one session received. */
function deliveries(handle: AgentHandle): Extract<SessionEvent, { type: 'user/message' }>[] {
  return handle.agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => (
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'schedule'
  ))
}

/** Require one assembled request to carry one scheduler delivery envelope verbatim. */
function expectDeliveryFraming(options: GenerateOptions, prompt: string): void {
  const reminder = options.messages.find(message => (
    message.source.kind === 'plugin' && message.source.plugin === 'schedule'
  ))
  expect(reminder?.role).toBe('user')
  const text = reminder?.content.find(block => block.type === 'text')?.text
  expect(text).toContain('Use schedule_list to review or schedule_delete to cancel.')
  expect(text).toContain(prompt)
}

/** Wait for and return one exact durable assistant reply. */
async function waitForReply(
  handle: AgentHandle,
  text: string,
  timeoutMs: number,
): Promise<SessionEvent<'assistant/message'>> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const event = handle.agent.session.events.find((candidate): candidate is SessionEvent<'assistant/message'> => (
      candidate.type === 'assistant/message' && assistantText(candidate) === text
    ))
    if (event !== undefined) return event
    if (Date.now() >= deadline) throw new Error(`assistant reply did not arrive within ${timeoutMs}ms: ${text}`)
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

/** Resolve the semantic assistant-step key owned by the conversation assembler. */
function assistantKey(event: SessionEvent<'assistant/message'>): string {
  return conversationContextKey('assistant-step', `${String(event.data.turn)}:${String(event.data.step)}`)
}

describe.skipIf(MODE === 'record')('web e2e: scheduler-driven conversational reminders', () => {
  let scaffold: WebScaffold
  let afterHandle: AgentHandle
  let atHandle: AgentHandle
  let everyHandle: AgentHandle
  let browser: Browser
  let page: Page
  let afterAssistantReply: SessionEvent<'assistant/message'> | undefined
  let atAssistantReply: SessionEvent<'assistant/message'> | undefined
  let everyPrimaryReply: SessionEvent<'assistant/message'> | undefined
  let everySecondaryReply: SessionEvent<'assistant/message'> | undefined
  let afterScheduleId: string | undefined
  let everyPrimaryId: string | undefined
  let everySecondaryId: string | undefined
  let tripwire: ReturnType<typeof watchConsole>
  const afterAdapter = new ReminderAdapter(AFTER_REPLY)
  const atAdapter = new BrowserZoneAtAdapter()
  const everyAdapter = new EveryPromptAdapter(new Map([
    [EVERY_PRIMARY_PROMPT, EVERY_REPLY_PRIMARY],
    [EVERY_SECONDARY_PROMPT, EVERY_REPLY_SECONDARY],
  ]))

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([AFTER_PROVIDER], afterAdapter),
      'Schedule Web After adapter',
    )
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([AT_PROVIDER], atAdapter),
      'Schedule Web At adapter',
    )
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([EVERY_PROVIDER], everyAdapter),
      'Schedule Web Every adapter',
    )

    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: 'en-US',
      timezoneId: AT_BROWSER_ZONE,
    })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
      .toBe(AT_BROWSER_ZONE)

    const cwd = join(scaffold.workspaceCwd, 'workspace')
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')

    afterHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('schedule-after-web-e2e'),
      meta: { cwd },
      agentOptions: { provider: AFTER_PROVIDER, model: MODEL },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    afterHandle.agent.session.append('session/title', {
      title: 'Scheduled After follow-up',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    await workspace.attachSession(afterHandle.agent.id)
    const afterCreated = await scaffold.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      callId: CallId('schedule-after-create'),
      name: 'schedule_create',
      arguments: {
        prompt: AFTER_PROMPT,
        run_at: new Date(Date.now() + 4_000).toISOString(),
      },
      agent: afterHandle.agent,
    })
    if (afterCreated.isError) {
      throw new Error(`Schedule After create failed: ${JSON.stringify(afterCreated.content)}`)
    }
    afterScheduleId = (afterCreated.value as { scheduleId: string }).scheduleId
    afterAssistantReply = await waitForReply(afterHandle, AFTER_REPLY, 30_000)
    await afterHandle.agent.whenIdle()
    await expect(scaffold.ctx.sessions.flush(afterHandle.agent.session)).resolves.toBe(true)

    everyHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('schedule-every-web-e2e'),
      meta: { cwd },
      agentOptions: { provider: EVERY_PROVIDER, model: MODEL },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    everyHandle.agent.session.append('session/title', {
      title: 'Fixed-rate reminder pair',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const seededAt = Date.now()
    const everyRecords = await Promise.all([
      scaffold.ctx.scheduler.create({
        prompt: EVERY_PRIMARY_PROMPT,
        rule: {
          kind: 'every',
          intervalMs: EVERY_INTERVAL_MS,
          anchor: new Date(seededAt - EVERY_PRIMARY_AGE_MS).toISOString(),
        },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: everyHandle.agent.session.id },
      }),
      scaffold.ctx.scheduler.create({
        prompt: EVERY_SECONDARY_PROMPT,
        rule: {
          kind: 'every',
          intervalMs: EVERY_INTERVAL_MS,
          anchor: new Date(seededAt + EVERY_SECONDARY_DELAY_MS).toISOString(),
        },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: everyHandle.agent.session.id },
      }),
    ])
    everyPrimaryId = everyRecords[0]?.id
    everySecondaryId = everyRecords[1]?.id
    everyPrimaryReply = await waitForReply(everyHandle, EVERY_REPLY_PRIMARY, 30_000)
    await everyHandle.agent.whenIdle()
    everySecondaryReply = await waitForReply(everyHandle, EVERY_REPLY_SECONDARY, 30_000)
    await everyHandle.agent.whenIdle()
    await expect(scaffold.ctx.sessions.flush(everyHandle.agent.session)).resolves.toBe(true)
    await workspace.attachSession(everyHandle.agent.id)

    atHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('schedule-at-web-e2e'),
      meta: { cwd },
      agentOptions: { provider: AT_PROVIDER, model: MODEL },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    atHandle.agent.session.append('session/title', {
      title: 'Explicit local-time reminder',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    atHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prepare the reminder test session.' }],
      source: { kind: 'plugin', plugin: 'schedule-web-e2e' },
    }))
    await atHandle.agent.whenIdle()
    expect(atAdapter.requests).toHaveLength(1)
    await expect(scaffold.ctx.sessions.flush(atHandle.agent.session)).resolves.toBe(true)
    await workspace.attachSession(atHandle.agent.id)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const workspaceItem = page.locator('[role="treeitem"]').first()
    await workspaceItem.waitFor({ timeout: 15_000 })
    const expansionDeadline = Date.now() + 5_000
    while (await workspaceItem.getAttribute('aria-expanded') !== 'true') {
      if (Date.now() >= expansionDeadline) throw new Error('workspace item did not expand')
      if (await workspaceItem.getAttribute('aria-expanded') !== 'true') {
        await workspaceItem.click()
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    const atSession = page.getByRole('treeitem', { name: /Explicit local-time reminder/ })
    await atSession.waitFor({ timeout: 15_000 })
    await atSession.click()
    const composer = page.locator('textarea:enabled').last()
    await composer.fill(AT_USER_PROMPT)
    const settled = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(atHandle.agent.id)
    await page.getByText(AT_ACK, { exact: true }).waitFor({ timeout: 15_000 })
    atAssistantReply = await waitForReply(atHandle, AT_REPLY, 30_000)
    await atHandle.agent.whenIdle()
    await expect(scaffold.ctx.sessions.flush(atHandle.agent.session)).resolves.toBe(true)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await atHandle?.dispose().catch((error: unknown) => failures.push(error))
    await everyHandle?.dispose().catch((error: unknown) => failures.push(error))
    await afterHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Schedule Web evidence teardown failed')
  })

  it('renders one delivered after-rule as an ordinary assistant follow-up', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-after'))
    const dispatches = afterHandle.agent.session.events.filter(event => (
      event.type === 'schedule/dispatch' && event.data.scheduleId === afterScheduleId
    ))
    expect(dispatches).toHaveLength(1)
    const delivered = deliveries(afterHandle)
    expect(delivered).toHaveLength(1)
    const text = delivered[0]?.data.content.find(block => block.type === 'text')?.text
    expect(text).toContain(`Scheduled task ${afterScheduleId ?? ''} fired`)
    expect(text).toContain(AFTER_PROMPT)
    const reminderRequest = afterAdapter.requests[0]
    if (reminderRequest === undefined) throw new Error('model did not receive the scheduler delivery')
    expectDeliveryFraming(reminderRequest, AFTER_PROMPT)
    const session = page.getByRole('treeitem', { name: /Scheduled After follow-up/ })
    await session.click()
    if (afterAssistantReply === undefined) throw new Error('After assistant reply was not captured')
    const selector = `[data-chat-anchor-key="${assistantKey(afterAssistantReply)}"]`
    const row = page.locator(selector)
    await row.waitFor({ timeout: 15_000 })
    expect(await row.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
    expect(await row.textContent()).toContain(AFTER_REPLY)
    await compareOrRefreshGolden(
      AFTER_EXPECTED,
      await captureStableAria(page, selector, scaffold.workspaceCwd),
      MODE,
    )
  }, 60_000)

  it('delivers each overdue every-rule as its own ordinary follow-up', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-every'))
    const dispatches = everyHandle.agent.session.events.filter(event => (
      event.type === 'schedule/dispatch'
      && (event.data.scheduleId === everyPrimaryId || event.data.scheduleId === everySecondaryId)
    ))
    expect(dispatches).toHaveLength(2)
    const delivered = deliveries(everyHandle)
    expect(delivered).toHaveLength(2)
    const deliveredText = delivered
      .map(event => event.data.content.find(block => block.type === 'text')?.text ?? '')
      .join('\n')
    expect(deliveredText).toContain(EVERY_PRIMARY_PROMPT)
    expect(deliveredText).toContain(EVERY_SECONDARY_PROMPT)
    const seen = new Set(everyAdapter.requests.map(options => (
      options.messages.find(message => (
        message.source.kind === 'plugin' && message.source.plugin === 'schedule'
      ))
    )))
    seen.delete(undefined)
    expect(seen.size).toBeGreaterThanOrEqual(1)
    const records = scaffold.ctx.scheduler.listForSession(everyHandle.agent.session.id)
    for (const record of records) {
      expect(record.status).toBe('active')
      expect(record.nextDue).toBeDefined()
      expect(record.nextDue).toBeGreaterThan(Date.now())
    }
    expect(records.every(record => record.lastError === undefined)).toBe(true)

    const session = page.getByRole('treeitem', { name: /Fixed-rate reminder pair/ })
    await session.click()
    if (everyPrimaryReply === undefined || everySecondaryReply === undefined) {
      throw new Error('Every assistant replies were not captured')
    }
    const selector = `[data-chat-anchor-key="${assistantKey(everyPrimaryReply)}"]`
    const row = page.locator(selector)
    await row.waitFor({ timeout: 15_000 })
    expect(await row.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
    expect(await row.textContent()).toContain(EVERY_REPLY_PRIMARY)
    await compareOrRefreshGolden(
      EVERY_EXPECTED,
      await captureStableAria(page, selector, scaffold.workspaceCwd),
      MODE,
    )
  }, 60_000)

  it('uses request-local browser context to create an explicit local run_at reminder', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-at'))
    const user = atHandle.agent.session.events.find(event => (
      event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === AT_USER_PROMPT)
    ))
    if (user?.type !== 'user/message' || user.data.source.kind !== 'user') {
      throw new Error('missing browser user-rpc message')
    }
    expect(user.data.source).toMatchObject({ kind: 'user', clientTimeZone: AT_BROWSER_ZONE })
    expect(typeof (user.data.source as { rpcId?: unknown }).rpcId).toBe('string')

    const firstRequest = atAdapter.requests[1]
    if (firstRequest === undefined) throw new Error('model did not receive the browser prompt')
    expect(requestText(firstRequest)).toContain(
      `Browser time zone for this request: ${AT_BROWSER_ZONE}. `
      + 'Interpret otherwise-unqualified dates and times in this zone.',
    )
    expect(firstRequest.tools?.some(tool => tool.name === 'schedule_create')).toBe(true)
    const selectedRunAt = atAdapter.selectedRunAt
    if (selectedRunAt === undefined) {
      throw new Error('model did not choose an explicit local run_at target')
    }

    const toolCall = atHandle.agent.session.events.find(event => (
      event.type === 'tool/call' && event.data.name === 'schedule_create'
    ))
    if (toolCall?.type !== 'tool/call') throw new Error('missing schedule_create tool call')
    expect(JSON.parse(toolCall.data.arguments)).toEqual({ prompt: AT_PROMPT, run_at: selectedRunAt })
    const dispatches = atHandle.agent.session.events.filter(event => (
      event.type === 'schedule/dispatch'
    ))
    expect(dispatches).toHaveLength(1)
    const delivered = deliveries(atHandle)
    expect(delivered).toHaveLength(1)
    expect(atAdapter.requests).toHaveLength(4)
    const reminderRequest = atAdapter.requests[3]
    if (reminderRequest === undefined) throw new Error('model did not receive the run_at reminder')
    expectDeliveryFraming(reminderRequest, AT_PROMPT)

    const session = page.getByRole('treeitem', { name: /Explicit local-time reminder/ })
    await session.click()
    if (atAssistantReply === undefined) throw new Error('At assistant reply was not captured')
    const selector = `[data-chat-anchor-key="${assistantKey(atAssistantReply)}"]`
    const row = page.locator(selector)
    await row.waitFor({ timeout: 15_000 })
    expect(await row.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
    expect(await row.textContent()).toContain(AT_REPLY)
    await compareOrRefreshGolden(
      AT_EXPECTED,
      await captureStableAria(page, selector, scaffold.workspaceCwd),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'at-conversation.expected.md',
      'conversation.expected.md',
      'every-conversation.expected.md',
    ])
  })
})
