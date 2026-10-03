// Web e2e scenario: archive admission over the real host. One replayed turn
// materializes the session, then a genuine `run_in_background` bash call owns
// a running job while the Agent itself stays idle; the row menu's Archive
// action meets the host's activity refusal, and the stop-and-archive
// confirmation lists the host-reported job before confirming stops it and
// commits the archive. The same walk pins the session from its row menu,
// proves the durable pin set, and proves archiving drops the pin. Zero model
// calls: the turn is replayed from a fixture, and the job is plain bash.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
// Each import binds this file's Context property merges for the per-file
// type program (tools, workspaceRegistry) that the lint lane builds.
import {} from '@deepseek-ai/dsh-tools'
import {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
// Long enough that the running assertions never race the loop finishing on
// its own; the confirm step's human kill settles it early.
const COMMAND = 'for i in $(seq 1 120); do echo "archive-active tick $i"; sleep 1; done'

describe.skipIf(MODE === 'record')('web e2e: stop-and-archive confirmation and session pinning', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent

  async function startBackgroundJob(): Promise<void> {
    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('archive-active-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Stream while archive admission asks', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (!/started background job bash-\d+/.test(reported)) {
      throw new Error(`background bash reported no job id: ${reported}`)
    }
  }

  /**
   * The fixture session's row and its display title: the single tree row
   * carrying a session actions button (a blank New Session row renders no
   * menu), anchored structurally because the title derives from the folded
   * first prompt.
   */
  async function fixtureSessionRow(): Promise<{ row: Locator; title: string }> {
    const row = page.getByRole('tree', { name: /sessions/i })
      .locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
      .first()
    const title = await row.locator('[class*="title"]').innerText()
    return { row, title }
  }

  /** Open the row's hover actions menu and pick one entry. */
  async function pickRowMenuAction(action: string): Promise<void> {
    const { row } = await fixtureSessionRow()
    await row.hover()
    await row.locator('button[aria-label^="Session actions for "]').click()
    await page.getByRole('menuitem', { name: action }).click()
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
    if (prompts.length !== 1) throw new Error('archive-active fixture must carry one prompt')
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

  it('pins from the row menu, holds the durable pin, and drops it with the archive', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-archive-active-pin'))
    expect([...scaffold.ctx.workspaceRegistry.pinnedSessionIds]).toEqual([])
    await pickRowMenuAction('Pin session')
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.pinnedSessionIds],
      { timeout: 10_000 },
    ).toEqual([SessionId(agent.id)])
    // The row menu now offers the unpin verb for the pinned row.
    const { row } = await fixtureSessionRow()
    await row.hover()
    await row.locator('button[aria-label^="Session actions for "]').click()
    await expect.poll(() => page.getByRole('menuitem', { name: 'Unpin session' }).isVisible()).toBe(true)
    await row.locator('button[aria-label^="Session actions for "]').click()
    // Unpin restores the unpinned set; the walk re-pins so the archive step
    // below proves the archive-drop, not the unpin.
    await pickRowMenuAction('Unpin session')
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.pinnedSessionIds],
      { timeout: 10_000 },
    ).toEqual([])
    await pickRowMenuAction('Pin session')
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.pinnedSessionIds],
      { timeout: 10_000 },
    ).toEqual([SessionId(agent.id)])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('a running job turns the archive action into the stop-and-archive confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-archive-active-dialog'))
    await startBackgroundJob()
    await expect.poll(
      () => scaffold.ctx.jobs.list(agent).filter(job => job.status === 'running').length,
      { timeout: 10_000 },
    ).toBe(1)
    const runningId = scaffold.ctx.jobs.list(agent).find(job => job.status === 'running')?.id
    expect(String(runningId)).toMatch(/^bash-\d+$/)
    void JobId
    // The Agent itself is idle (the turn is done), so the row menu offers
    // Archive; the host answers with the job family, not a quiet commit.
    await pickRowMenuAction('Archive session')
    const dialogText = (pattern: string | RegExp): Locator =>
      page.getByRole('dialog').getByText(pattern)
    await expect.poll(() => dialogText('Stop and archive session').isVisible(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => dialogText('Background jobs').isVisible()).toBe(true)
    await expect.poll(() => dialogText(/archive-active tick/).isVisible()).toBe(true)
    // Nothing stopped or archived yet: cancel keeps the row and the job.
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false)
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([])
    expect(scaffold.ctx.jobs.list(agent).filter(job => job.status === 'running').length).toBe(1)
    // Confirm: archive first, then the stop; the row hides, the pin dropped
    // with the same durable write, and the job settles as killed.
    await pickRowMenuAction('Archive session')
    await expect.poll(() => dialogText('Stop and archive session').isVisible(), { timeout: 10_000 }).toBe(true)
    await page.getByRole('dialog').getByRole('button', { name: 'Stop and archive' }).click()
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.archivedSessionIds],
      { timeout: 15_000 },
    ).toEqual([SessionId(agent.id)])
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.pinnedSessionIds],
      { timeout: 15_000 },
    ).toEqual([])
    const statuses = (): string[] => scaffold.ctx.jobs.list(agent).map(job => job.status)
    await expect.poll(statuses, { timeout: 15_000 }).toContain('killed')
    await expect.poll(
      () => page.getByRole('tree', { name: /sessions/i })
        .locator('[role="treeitem"]')
        .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
        .count(),
      { timeout: 15_000 },
    ).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
