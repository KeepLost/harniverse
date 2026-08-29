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
const WORKBENCH_PREVIEW_EXPECTED = join(SNAPSHOT_DIR, 'workbench-preview.expected.md')
const WORKBENCH_DRAWER_PREVIEW_EXPECTED = join(SNAPSHOT_DIR, 'workbench-drawer-preview.expected.md')
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

    const navigation = workbench.getByRole('tabpanel')
    await navigation.getByRole('button', { name: /README\.md$/ }).click()
    let preview = page.getByRole('region', { name: 'Workspace file preview' })
    await preview.getByRole('heading', { name: 'Workbench E2E' }).waitFor({ timeout: 10_000 })
    const sidebarBox = await frame.locator(':scope > *').first().boundingBox()
    const previewClip = preview.locator('..')
    const enteringClipBox = await previewClip.boundingBox()
    if (enteringClipBox === null || sidebarBox === null) throw new Error('frame surface has no layout box')
    expect(enteringClipBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1)
    const dockedPreviewSnapshot = await captureStableAria(page, '[role="region"][aria-label="Workspace file preview"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WORKBENCH_PREVIEW_EXPECTED, dockedPreviewSnapshot, MODE)
    const detailsSeparator = page.getByRole('separator', { name: 'Resize right panel' })
    await detailsSeparator.focus()
    await detailsSeparator.press('ArrowLeft')
    await expect.poll(async () => {
      const currentSidebar = await frame.locator(':scope > *').first().boundingBox()
      const currentWorkbench = await workbench.boundingBox()
      const currentClip = await previewClip.boundingBox()
      if (currentSidebar === null || currentWorkbench === null || currentClip === null) return Number.POSITIVE_INFINITY
      return Math.max(
        currentSidebar.x + currentSidebar.width - currentClip.x,
        Math.abs(currentClip.x + currentClip.width - currentWorkbench.x),
      )
    }, { timeout: 10_000 }).toBeLessThanOrEqual(1)
    await detailsSeparator.press('ArrowRight')
    await expect.poll(async () => {
      const workbenchBox = await workbench.boundingBox()
      const clipBox = await previewClip.boundingBox()
      if (workbenchBox === null || clipBox === null) return Number.POSITIVE_INFINITY
      return Math.abs(clipBox.x + clipBox.width - workbenchBox.x)
    }, { timeout: 10_000 }).toBeLessThanOrEqual(1)
    const clipBox = await previewClip.boundingBox()
    if (clipBox === null) throw new Error('preview clip has no settled layout box')
    expect(clipBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1)
    await workbench.getByRole('button', { name: 'Close workspace workbench' }).click()
    await expect.poll(() => preview.count(), { timeout: 10_000 }).toBe(0)
    await page.getByRole('button', { name: 'Open workspace workbench' }).click()
    await workbench.waitFor({ timeout: 10_000 })
    expect(await page.getByRole('region', { name: 'Workspace file preview' }).count()).toBe(0)

    await workbench.getByRole('tab', { name: 'Search', exact: true }).click()
    await navigation.getByRole('button', { name: 'Filter scope' }).click()
    await navigation.getByLabel('Files to include').fill('*.ts')
    await navigation.getByLabel('Files to exclude').fill('dist/')
    await navigation.getByRole('searchbox', { name: 'Search workspace files' }).fill('tracked')
    await navigation.getByRole('button', { name: /tracked\.ts/ }).click()
    preview = page.getByRole('region', { name: 'Workspace file preview' })
    await preview.getByText('export const state = 2', { exact: false }).waitFor({ timeout: 10_000 })
    await preview.getByRole('button', { name: 'Close file preview' }).click()

    await workbench.getByRole('tab', { name: 'Changes', exact: true }).click()
    await navigation.getByText('Branch main', { exact: true }).waitFor({ timeout: 10_000 })
    await navigation.getByRole('button', { name: /M.*tracked\.ts/ }).click()
    preview = page.getByRole('region', { name: 'Workspace file preview' })
    await preview.getByText('diff --git', { exact: false }).waitFor({ timeout: 10_000 })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => frame.getAttribute('data-right-drawer'), { timeout: 10_000 }).toBe('true')
    let drawerPreview = workbench.getByRole('region', { name: 'Workspace file preview' })
    await drawerPreview.waitFor({ timeout: 10_000 })
    const drawerPreviewSnapshot = await captureStableAria(page, '[role="region"][aria-label="Workspace file preview"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WORKBENCH_DRAWER_PREVIEW_EXPECTED, drawerPreviewSnapshot, MODE)
    await drawerPreview.getByRole('button', { name: 'Close file preview' }).click()
    await workbench.getByRole('tab', { name: 'Files', exact: true }).click()
    await navigation.getByRole('button', { name: /README\.md$/ }).click()
    drawerPreview = workbench.getByRole('region', { name: 'Workspace file preview' })
    await drawerPreview.waitFor({ timeout: 10_000 })
    await drawerPreview.getByRole('button', { name: 'Close file preview' }).click()
    await expect.poll(() => navigation.isVisible(), { timeout: 10_000 }).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WORKBENCH_EXPECTED, snapshot, MODE)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('guards the snapshot inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'workbench.expected.md', 'workbench-preview.expected.md', 'workbench-drawer-preview.expected.md',
    ])
  })
})
