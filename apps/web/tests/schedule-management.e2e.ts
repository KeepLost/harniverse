// Web e2e scenario: the scheduled-task management surface — the sidebar
// footer trigger (pressed affordance), the center view covering the
// conversation (empty state, create through the drawer with a named rule,
// row verbs pause/resume, prompt edit, delete back to empty), and the exit
// back to the conversation. Zero model calls: the scheduler Remote and the
// storage-domain table carry everything, so a stray stream would fail loud
// on the open llm seam.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedBlankSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/schedule-management', import.meta.url))
const TABLE_EXPECTED = join(SNAPSHOT_DIR, 'table.expected.md')
const SESSION_ID = 'schedule-management-web-e2e'
const MODE = webSnapshotMode()

describe('web e2e: scheduled-task management view', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let harnessHome: string

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-schedule-home-'))
    scaffold = await launchWebScaffold({ harnessHome })
    // Creation attributes to the owning session, so boot with one blank
    // Session the frame auto-selects.
    const cwd = join(scaffold.workspaceCwd, 'schedule-management')
    await mkdir(cwd, { recursive: true })
    await seedBlankSession(scaffold, SESSION_ID, cwd)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('opens the management view from the sidebar footer above Settings and back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-open'))
    const trigger = page.getByRole('button', { name: '打开定时任务' })
    await trigger.waitFor({ timeout: 10_000 })
    // The footer stacks the trigger above the Settings entry.
    const settings = page.getByRole('button', { name: '设置', exact: true })
    expect((await trigger.boundingBox())!.y).toBeLessThan((await settings.boundingBox())!.y)
    expect(await trigger.getAttribute('aria-pressed')).toBe('false')

    await trigger.click()
    const view = page.getByRole('region', { name: '定时任务' })
    await view.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-pressed')).toBe('true')
    // Blank boot: every schedule table is empty.
    await view.getByText('还没有任何定时任务。').waitFor({ timeout: 10_000 })

    // The exit returns to the conversation and releases the trigger.
    await view.getByRole('button', { name: '返回会话' }).click()
    await page.getByRole('region', { name: '定时任务' }).waitFor({ state: 'hidden', timeout: 10_000 })
    expect(await trigger.getAttribute('aria-pressed')).toBe('false')
  })

  it('creates a schedule through the drawer and exercises the row verbs', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-crud'))
    const trigger = page.getByRole('button', { name: '打开定时任务' })
    await trigger.click()
    const view = page.getByRole('region', { name: '定时任务' })
    await view.waitFor({ timeout: 10_000 })
    await view.getByText('还没有任何定时任务。').waitFor({ timeout: 10_000 })

    // Create: prompt + a 30-minute one-shot delay bound to this session —
    // unlike an every-rule (anchored now, so it fires immediately), nothing
    // dispatches during the scenario and the table stays deterministic.
    await view.getByRole('button', { name: '新建任务' }).click()
    const drawer = page.getByRole('dialog', { name: '新建定时任务' })
    await drawer.waitFor({ timeout: 10_000 })
    await drawer.getByLabel('指令').fill('整理收件箱并汇总未读')
    await drawer.getByLabel('执行规则').selectOption('after')
    await drawer.getByLabel('延迟（分钟）').fill('30')
    await drawer.getByRole('button', { name: '保存' }).click()
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 })

    const row = view.locator('[data-schedule-row]').first()
    await row.waitFor({ timeout: 10_000 })
    expect(await row.getByText('整理收件箱并汇总未读').isVisible()).toBe(true)
    expect(await row.getByText('本会话').isVisible()).toBe(true)
    expect(await row.getByText('30 分钟后').isVisible()).toBe(true)
    expect(await row.getByText('运行中').isVisible()).toBe(true)

    // Normalize the per-run schedule id and calendar date before comparing:
    // both vary between record and replay runs.
    const scheduleId = ((await row.locator('td').first().textContent()) ?? '').trim()
    const snapshot = (await captureStableAria(page, '[aria-label="定时任务"]', scaffold.workspaceCwd))
      .split(scheduleId).join('{{scheduleId}}')
      .replace(/\d{4}\/\d{1,2}\/\d{1,2}/g, '{{date}}')
    await compareOrRefreshGolden(TABLE_EXPECTED, snapshot, MODE)

    // Pause and resume flip the status vocabulary in place.
    await row.getByRole('button', { name: '暂停' }).click()
    await expect.poll(async () => row.getByText('已暂停').isVisible(), { timeout: 10_000 }).toBe(true)
    await row.getByRole('button', { name: '恢复' }).click()
    await expect.poll(async () => row.getByText('运行中').isVisible(), { timeout: 10_000 }).toBe(true)

    // Edit the prompt through the drawer; the row shows the new text.
    await row.getByRole('button', { name: '编辑' }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑定时任务' })
    await editDrawer.waitFor({ timeout: 10_000 })
    await editDrawer.getByText('暂无执行').waitFor({ timeout: 10_000 })
    await editDrawer.getByLabel('指令').fill('整理收件箱并汇总未读（修订）')
    await editDrawer.getByRole('button', { name: '保存' }).click()
    await editDrawer.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(async () => row.getByText('整理收件箱并汇总未读（修订）').isVisible(), { timeout: 10_000 }).toBe(true)

    // Delete returns the view to the empty state.
    await row.getByRole('button', { name: '删除' }).click()
    await view.getByText('还没有任何定时任务。').waitFor({ timeout: 10_000 })
    await view.getByRole('button', { name: '返回会话' }).click()
    await page.getByRole('region', { name: '定时任务' }).waitFor({ state: 'hidden', timeout: 10_000 })
  })
})
