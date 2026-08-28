import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const execFileAsync = promisify(execFile)
const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-workbench', import.meta.url))
const WORKBENCH_EXPECTED = join(SNAPSHOT_DIR, 'workbench.expected.md')
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: read-only Workspace workbench', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, paceMs: 5 })
    const workspace = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'README.md'), '# Workbench E2E\n\nAuthenticated preview.\n')
    await writeFile(join(workspace, 'tracked.ts'), 'export const state = 1\n')
    await execFileAsync('git', ['init', '-b', 'main', workspace])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Workbench Test'])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'workbench@example.invalid'])
    await execFileAsync('git', ['-C', workspace, 'add', '--', 'README.md', 'tracked.ts'])
    await execFileAsync('git', ['-C', workspace, 'commit', '-m', 'initial'])
    await writeFile(join(workspace, 'tracked.ts'), 'export const state = 2\n')

    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const deviceName = page.getByLabel('设备名称')
    await deviceName.waitFor({ timeout: 30_000 })
    await deviceName.fill('Workbench E2E')
    const enrollmentResponse = page.waitForResponse(response => (
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/auth/enrollment'
    ))
    await page.getByRole('button', { name: '配对个人设备' }).click()
    expect((await enrollmentResponse).status()).toBe(202)
    const requests = await listEnrollmentRequests({ dshHome: scaffold.harnessHome })
    expect(requests).toHaveLength(1)
    await approveEnrollmentRequest(requests[0]!.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome: scaffold.harnessHome })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('docks on desktop and becomes a navigable mobile drawer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-workbench'))
    await page.getByRole('button', { name: 'Open workspace workbench' }).click()
    const workbench = page.getByRole('complementary', { name: 'Workspace workbench' })
    await workbench.waitFor({ timeout: 15_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    await expect.poll(() => frame.getAttribute('data-right-mode'), { timeout: 10_000 }).toBe('workbench')
    expect(await frame.getAttribute('data-right-drawer')).toBeNull()
    expect(await page.getByRole('separator', { name: 'Resize right panel' }).count()).toBe(1)

    const navigation = workbench.getByRole('region', { name: 'Workspace navigation' })
    await navigation.getByRole('button', { name: /README\.md$/ }).click()
    await workbench.getByRole('heading', { name: 'Workbench E2E' }).waitFor({ timeout: 10_000 })

    await workbench.getByRole('button', { name: 'Search', exact: true }).click()
    await navigation.getByRole('searchbox', { name: 'Search workspace files' }).fill('tracked')
    await navigation.getByRole('button', { name: /tracked\.ts/ }).click()
    await workbench.getByText('export const state = 2', { exact: false }).waitFor({ timeout: 10_000 })

    await workbench.getByRole('button', { name: 'Changes', exact: true }).click()
    await navigation.getByText('Branch main', { exact: true }).waitFor({ timeout: 10_000 })
    await navigation.getByRole('button', { name: /M.*tracked\.ts/ }).click()
    await workbench.getByText('diff --git', { exact: false }).waitFor({ timeout: 10_000 })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => frame.getAttribute('data-right-drawer'), { timeout: 10_000 }).toBe('true')
    const back = workbench.getByRole('button', { name: 'Back to file navigation' })
    await back.waitFor({ timeout: 10_000 })
    await back.click()
    await workbench.getByRole('button', { name: 'Files', exact: true }).click()
    await navigation.getByRole('button', { name: /README\.md$/ }).click()
    await back.waitFor({ timeout: 10_000 })
    await back.click()
    await expect.poll(() => navigation.isVisible(), { timeout: 10_000 }).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WORKBENCH_EXPECTED, snapshot, MODE)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('guards the snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['workbench.expected.md'])
  })
})
