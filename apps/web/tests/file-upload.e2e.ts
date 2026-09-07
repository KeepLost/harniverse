// Web e2e contract for the A5 generic-file upload path: a real browser pick
// through the composer's file entry, the real Host upload route (loopback
// trust + auth bypass), the chip's upload lifecycle, prompt admission with
// file parts, the log-only user/file event pair, the durable handle text the
// model sees, the badge row's DOM shape, and the route's trust fence denying
// a forged cross-origin caller. One deterministic replay turn.
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, conversationContextKey, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

const FILE_NAME = 'e2e-notes.txt'
const FILE_BODY = 'A5 file upload e2e payload.\nDeterministic bytes for the receipt digest.\n'
const USER_MARKER = 'FILE_UPLOAD_USER_001'
const FIRST_MARKER = 'FILE_UPLOAD_FIRST_001'
const DONE_MARKER = 'FILE_UPLOAD_DONE_001'

function textStream(): StreamChunk[] {
  const response = `${FIRST_MARKER} acknowledged the attachment. ${DONE_MARKER}`
  const deltas = [`${FIRST_MARKER} `, 'acknowledged ', 'the attachment. ', `${DONE_MARKER}`]
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    {
      type: 'usage',
      usage: { inputTokens: Math.ceil(FILE_BODY.length / 4), outputTokens: Math.ceil(response.length / 4) },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function replayScript(): ReplayOverrideDoc {
  const final: ReplayEntry = { kind: 'chunks', chunks: textStream() }
  return [final]
}

function userText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('web e2e: composer file upload through the real host route', () => {
  let browser: Browser
  let page: Page
  let replayDir: string
  let scaffold: WebScaffold
  let tripwire: ReturnType<typeof watchConsole>
  const consoleWarnings: string[] = []
  const sessionEvents: SessionEvent[] = []
  const expectedId = `sha256:${createHash('sha256').update(FILE_BODY, 'utf8').digest('hex')}`
  const sha8 = expectedId.slice('sha256:'.length, 'sha256:'.length + 8)

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-file-upload-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replayScript()))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      replayContextWindow: 10_000_000,
      paceMs: 10,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => {
      sessionEvents.push(event)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'warning') consoleWarnings.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'file-upload-e2e')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'file-upload e2e cleanup failed')
  })

  it.skipIf(MODE === 'record')('uploads a picked file, admits it with the prompt, and badges the message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload'))
    const composer = page.locator('textarea:enabled').last()
    await composer.waitFor({ timeout: 15_000 })

    // Pick through the composer's real file entry; the chip rides the real
    // upload route (loopback trust, auth bypass) to a content-addressed receipt.
    const fileInput = page.locator('[data-file-input]')
    await fileInput.setInputFiles({ name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_BODY, 'utf8') })
    await page.locator(`[data-file-chip="done"][data-file-name="${FILE_NAME}"]`).waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-file-chip]').textContent()).toContain(FILE_NAME)

    const eventStart = sessionEvents.length
    const settled = scaffold.whenTurnSettled(60_000)
    await composer.fill(`${USER_MARKER} Read the attached notes and summarize.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()

    // The chip leaves with the accepted prompt.
    await expect.poll(() => page.locator('[data-file-chip]').count(), { timeout: 15_000 }).toBe(0)

    const turnEvents = (): SessionEvent[] => sessionEvents.slice(eventStart)
    await expect.poll(() => turnEvents().some(event => event.type === 'user/message'), { timeout: 15_000 }).toBe(true)
    const fileEvent = turnEvents().find(
      (event): event is SessionEvent<'user/file'> => event.type === 'user/file',
    )
    if (fileEvent === undefined) throw new Error('prompt produced no user/file event')
    // Position association: the paired message is the first user/message
    // AFTER the log-only file event (the queue may record an earlier copy).
    const message = turnEvents().find(
      (event): event is SessionEvent<'user/message'> => (
        event.type === 'user/message' && event.seq > fileEvent.seq
      ),
    )
    if (message === undefined) throw new Error('user/file produced no following user/message')

    // Event association: the log-only file event precedes its message, and the
    // message source carries the receipt the upload route minted.
    expect(fileEvent.seq).toBe(message.seq - 1)
    expect(fileEvent.data.files).toHaveLength(1)
    expect(fileEvent.data.files[0]).toMatchObject({
      attachmentId: expectedId,
      bytes: Buffer.byteLength(FILE_BODY, 'utf8'),
      name: FILE_NAME,
      mediaType: 'text/plain',
    })
    expect(message.data.source).toMatchObject({
      kind: 'user',
      files: [{ attachmentId: expectedId, name: FILE_NAME }],
    })

    // Model-visible: the durable content carries the deterministic handle text.
    const handle = userText(message)
    expect(handle).toContain(`${USER_MARKER} Read the attached notes and summarize.`)
    expect(handle).toContain(`[文件] ${FILE_NAME} · ${Buffer.byteLength(FILE_BODY, 'utf8')} B · sha256:${sha8}`)
    expect(handle).toContain('只读路径: ')
    expect(handle).toContain('用 read 工具读取该路径获得内容；不要凭名字猜测内容。')

    // DOM: the badge row shows the file; the raw handle lines never render.
    const userRow = page.locator(`[data-chat-anchor-key="${conversationContextKey('input-message', String(message.data.id))}"]`)
    await expect.poll(() => userRow.count(), { timeout: 10_000 }).toBe(1)
    await userRow.locator(`[data-file-badge="${FILE_NAME}"]`).waitFor({ timeout: 10_000 })
    expect(await userRow.textContent()).toContain(FILE_NAME)
    expect(await userRow.textContent()).not.toContain('只读路径')
    expect(await userRow.textContent()).not.toContain('sha256')

    await settled
    await page.getByText(DONE_MARKER, { exact: false }).last().waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
    await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe('')

    // Trust fence: the route denies a forged cross-origin caller before any
    // storage or capability check (the observer/no-operate arm stays covered by
    // the route's unit suite — the scaffold's loopback bypass only mints the
    // owner principal).
    const forged = await page.request.post(`${scaffold.baseUrl}/api/attachment/upload`, {
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      data: 'untrusted',
    })
    expect(forged.status()).toBe(403)

    expect(consoleWarnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
