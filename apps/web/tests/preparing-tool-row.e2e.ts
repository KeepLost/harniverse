// Web e2e scenario: a streamed named tool-call delta renders the preparing
// row while its arguments are still streaming. Replay-pins the recorded
// fs-write fixture through the real loop and holds the llm/stream waterfall
// mid-arguments, so the transient preparation is observable in the browser:
// the write row shows the tool-owned preparing state with its kilobyte
// progress and no expandable body, then the promoting tool/call replaces it.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/fs-write/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_PROMPT = 'Use the write tool (NOT bash) to create a file named notes.txt in the current directory containing exactly the single line: hello world. Then reply with exactly the single word DONE.'

/** The held write call's identity and streamed-argument size at the hold point. */
interface Preparation {
  callId: string
  kilobytes: number
}

describe.skipIf(MODE === 'record')('web e2e: preparing tool row during argument streaming', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let releasePreparations: (() => void) | undefined
  let preparationReady: Promise<Preparation> | undefined

  beforeAll(async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([SEED_PROMPT])
    scaffold = await launchWebScaffold({
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    // Hold the write call's argument stream after its first non-empty delta:
    // the preparing row must exist — with streamed-argument progress and no
    // expandable body — while the dispatch has not happened yet.
    const ready = Promise.withResolvers<Preparation>()
    const release = Promise.withResolvers<undefined>()
    preparationReady = ready.promise
    let held = false
    const streamedBytes = new Map<string, number>()
    const names = new Map<string, string>()
    const dispose = scaffold.ctx.on('llm/stream', async function* (_options, next) {
      for await (const chunk of next()) {
        if (chunk.type !== 'tool-call-delta') {
          yield chunk
          continue
        }
        const callId = String(chunk.id)
        if (chunk.name !== undefined) names.set(callId, chunk.name)
        const bytes = (streamedBytes.get(callId) ?? 0) + chunk.argumentsDelta.length
        streamedBytes.set(callId, bytes)
        if (names.get(callId) === 'write' && !held && chunk.argumentsDelta.length > 0) {
          held = true
          yield chunk
          ready.resolve({ callId, kilobytes: Math.ceil(bytes / 1024) })
          await release.promise
          continue
        }
        yield chunk
      }
    }, { prepend: true })
    releasePreparations = () => {
      release.resolve(undefined)
      dispose()
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    releasePreparations?.()
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the preparing row with streamed-argument progress, then the dispatched row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preparing-tool-row'))
    const settled = (async () => {
      const input = page.locator('textarea').first()
      await input.waitFor({ timeout: 10_000 })
      await input.fill(SEED_PROMPT)
      await input.press('Enter')
    })()
    const { callId, kilobytes } = await preparationReady!
    const row = page.locator(`[data-chat-call-id="${callId}"] [data-state="preparing"]`)
    await row.waitFor({ state: 'attached', timeout: 15_000 })
    await row.getByText(`Preparing content ${kilobytes}KB`, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await row.getByRole('button').count()).toBe(0)
    expect(await row.locator('pre').count()).toBe(0)
    releasePreparations?.()
    await settled
    const dispatched = page.locator(`[data-chat-call-id="${callId}"]`)
    await dispatched.locator('[data-state="ok"], [data-state="running"]').first().waitFor({ timeout: 30_000 })
    await dispatched.getByText('notes.txt', { exact: false }).waitFor({ timeout: 30_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
