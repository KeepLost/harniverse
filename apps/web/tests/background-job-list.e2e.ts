// Web e2e scenario: the session-header background-job list over the real
// host. One replayed turn materializes the real session header, then a genuine
// `run_in_background` bash call registers with `ctx.jobs`; the assertion chain
// is the whole delivery
// path: registry change feed → api-proxy `session/jobs` frame → the client's
// `jobsBySession` mirror → the header action.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/background-job-list', import.meta.url))
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const MODE = webSnapshotMode()
// Long enough that the running assertions never race the process exiting on
// their own; the test kills it explicitly to reach the settled state.
const COMMAND = 'sleep 45'

describe.skipIf(MODE === 'record')('web e2e: background job list', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let jobId: JobId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    if (prompts.length !== 1) throw new Error('background job fixture must carry one prompt')
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea:not([readonly]):not([disabled])').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    await settled
    const root = scaffold.ctx.agents.roots()[0]
    if (root === undefined) throw new Error('fresh workspace did not publish its live Agent')
    agent = root
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a running background job in the session header without a refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-running'))
    // Point assertion, not a poll: `expect.poll` retries until a predicate
    // holds, so polling for zero passes at t=0 and proves nothing. The
    // "renders nothing without a task" branch is owned by the component suite.
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(0)

    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('background-job-list-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Hold a background slot open', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-\d+\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    jobId = JobId(matched[0])

    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const row = page.getByRole('list', { name: 'Background jobs' }).getByRole('listitem').first()
    await row.waitFor({ timeout: 10_000 })
    await expect.poll(() => row.textContent()).toContain(COMMAND)

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('flips the open list to the cancelled outcome when the registry settles it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-settled'))
    expect(scaffold.ctx.jobs.kill(jobId, agent, 'web e2e cancellation')).toBe('requested')

    // The trigger drops its live count once the task leaves running/stopping,
    // which is also the proof that settlement reached the browser unprompted.
    const idle = page.getByRole('button', { name: '1 background job' })
    await idle.waitFor({ timeout: 20_000 })

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md', 'settled.expected.md'])
  })
})
