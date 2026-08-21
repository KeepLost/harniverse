/** Browser proof for the Agent Profile assembly Settings workflow. */

import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

describe('web e2e: Profile assembly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps one recipe catalog across targets and applies inherited global composition through preview', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-capability-composition'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Profile 组装', exact: true }).click()

    const target = dialog.getByRole('combobox', { name: '应用范围' })
    await target.waitFor({ timeout: 30_000 })
    const rows = dialog.locator('li[data-enabled]')
    const globalCount = await rows.count()
    expect(globalCount).toBeGreaterThan(0)

    await target.selectOption('profile:standard')
    await expect.poll(() => target.isEnabled()).toBe(true)
    await expect.poll(() => rows.count()).toBe(globalCount)
    await target.selectOption('profile:minimal')
    await expect.poll(() => target.isEnabled()).toBe(true)
    await expect.poll(() => rows.count()).toBe(globalCount)
    await target.selectOption('global')
    await expect.poll(() => target.isEnabled()).toBe(true)

    const bash = dialog.getByRole('heading', { name: 'bash' }).locator('xpath=ancestor::li')
    await bash.getByRole('radio', { name: '卸载' }).click()

    await dialog.getByRole('button', { name: '预览影响' }).click()
    await dialog.getByText('依赖检查通过，可以安全应用。').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '保存组装清单' }).click()

    await expect.poll(() => dialog.getByText('项待处理变更').count(), { timeout: 10_000 }).toBe(0)
    const refreshedBash = dialog.getByRole('heading', { name: 'bash' }).locator('xpath=ancestor::li')
    await expect.poll(() => refreshedBash.getByText('未选择加载').count(), { timeout: 10_000 }).toBe(1)

    await target.selectOption('profile:minimal')
    await expect.poll(() => target.isEnabled()).toBe(true)
    const inheritedBash = dialog.getByRole('heading', { name: 'bash' }).locator('xpath=ancestor::li')
    await inheritedBash.getByText('继承自全局默认值：卸载').waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
