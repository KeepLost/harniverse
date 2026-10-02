// Web e2e scenario: the expanded background-job output viewer and the
// two-step human stop over the real host. One replayed turn materializes the
// session header, then a genuine `run_in_background` bash call emits a rising
// line stream; the assertion chain is the whole delivery path: registry ring
// → api-proxy `jobs.follow` RPC → the browser poll → the read-only pane, and
// the armed stop button → `jobs.kill` RPC → the `stopping`/`killed` row view.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareGoldenWhenSettled,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/job-follow-stop', import.meta.url))
const EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'expanded.expected.md')
const STOPPED_EXPECTED = join(SNAPSHOT_DIR, 'stopped.expected.md')
const MODE = webSnapshotMode()
// A rising one-line-per-second stream: long enough that the running
// assertions never race the loop finishing on its own, and the expanded pane
// observably grows between polls.
const COMMAND = 'for i in $(seq 1 120); do echo "job-follow-stop tick $i"; sleep 1; done'
// The expanded pane's text grows every second and how much of it a run
// captured depends on when the stop landed, so both goldens drop the log
// region's aria line entirely and keep the surrounding chrome, whose
// stability the capture's two-equal-frames rule enforces.
const STRIP_OUTPUT_LOG = [/^\s*- log "Background job output"/]

describe.skipIf(MODE === 'record')('web e2e: job follow and stop', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent

  async function startBackgroundJob(): Promise<void> {
    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('job-follow-stop-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Stream rising output lines', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (!/started background job bash-\d+/.test(reported)) {
      throw new Error(`background bash reported no job id: ${reported}`)
    }
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    if (prompts.length !== 1) throw new Error('job follow/stop fixture must carry one prompt')
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

  it('streams the output ring into the expanded row viewer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-job-follow-expanded'))
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(0)

    await startBackgroundJob()
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const rows = page.getByRole('list', { name: 'Background jobs' }).getByRole('listitem')
    await rows.first().waitFor({ timeout: 10_000 })

    await rows.first().getByRole('button', { name: 'Show output' }).click()
    const pane = rows.first().getByRole('log', { name: 'Background job output' })
    // The pane polls from offset 0, so the first line lands once the first
    // follow round-trips; a later tick proves the poll keeps appending.
    await expect.poll(() => pane.textContent()).toContain('job-follow-stop tick 1')
    await expect.poll(() => pane.textContent(), { timeout: 15_000 }).toContain('job-follow-stop tick 3')

    await compareGoldenWhenSettled(
      EXPANDED_EXPECTED,
      () => captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd, STRIP_OUTPUT_LOG),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('stops through the armed confirm step and settles the row to the cancelled view', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-job-follow-stopped'))
    const row = page.getByRole('list', { name: 'Background jobs' }).getByRole('listitem').first()
    const stop = row.getByRole('button', { name: 'Stop' })
    await stop.click()
    const confirm = row.getByRole('button', { name: 'Confirm stop' })
    await confirm.waitFor({ timeout: 5_000 })

    await confirm.click()
    // The human stop flips the registry record; the mux push carries the
    // stopping transition and then the producer's terminal outcome, and the
    // trigger losing its live count proves the settlement reached the browser
    // unprompted.
    await expect.poll(() => row.textContent()).toMatch(/stopping|signal: SIGTERM|cancelled/)
    await page.getByRole('button', { name: '1 background job' }).waitFor({ timeout: 20_000 })

    await compareGoldenWhenSettled(
      STOPPED_EXPECTED,
      () => captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd, STRIP_OUTPUT_LOG),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['expanded.expected.md', 'stopped.expected.md'])
  })
})
