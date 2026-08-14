// Keyless browser e2e: the provider-neutral composition never asks for an
// official DeepSeek key. A user configures a pi-ai provider through the real
// wire; zero model calls occur.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const CREDENTIAL_STEP = '添加一个 API Key 开始使用'

describe('web e2e: provider-neutral first run', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('configures and reloads a pi-ai provider without DeepSeek state', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-provider-neutral-first-run'))
    expect(await page.getByRole('dialog', { name: CREDENTIAL_STEP }).count()).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    expect(await settings.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)' }).count()).toBe(0)

    const add = settings.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByLabel('提供方')
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await expect.poll(
      async () => page.getByRole('dialog', { name: CREDENTIAL_STEP }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const reloadedSettings = page.getByRole('dialog', { name: '设置' })
    await reloadedSettings.waitFor({ timeout: 10_000 })
    await reloadedSettings.getByRole('button', { name: '模型' }).click()
    await reloadedSettings.getByRole('button', { name: '编辑 minimax-cn' }).waitFor({ timeout: 10_000 })
    expect(await reloadedSettings.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)' }).count()).toBe(0)
    expect(await reloadedSettings.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
