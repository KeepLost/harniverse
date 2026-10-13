// Web e2e scenario: the Model Policy page end to end through the real wire —
// a reference-free provider profile registers its route so the catalog serves
// models, then a fallback chain is built and reordered from that catalog, a
// profile allows the model plus the chain with a default target, and the
// default-profile select writes the document. The referenced chain's delete is
// locked, and the new-session hero chip offers the configured profile and
// applies a live switch to the blank session. Zero model calls: configuration
// is pure settings/credentials/llm-domain traffic, so there is no fixture and
// a stray stream would fail loud because no turn ever runs.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareGoldenWhenSettled,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-policy', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Model Policy page manages profiles and fallback chains', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('registers a reference-free provider so the catalog serves models', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-provider'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const add = dialog.getByRole('button', { name: '添加提供方' })
    await add.waitFor({ timeout: 10_000 })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    await dialog.getByLabel('提供方').waitFor({ timeout: 10_000 })
    await dialog.getByLabel('提供方').selectOption('minimax-cn')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
  }, 60_000)

  it('renders the empty policy page with the unrestricted default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-empty'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型方案', exact: true }).click()
    await dialog.getByText('方案决定一个会话可使用的模型与备用链；备用链在同模型重试放弃后按顺序尝试后续模型。')
      .waitFor({ timeout: 10_000 })
    await dialog.getByText('还没有备用链。').waitFor({ timeout: 10_000 })
    await dialog.getByText('还没有方案。新会话将以「不限制」运行。').waitFor({ timeout: 10_000 })
    expect(await dialog.getByLabel('新会话默认方案').inputValue()).toBe('unrestricted')
    // The empty texts render from the default doc while the settings describe
    // is still in flight, and that loading frame is read-only; poll against
    // the golden so a slow describe cannot pin the mid-load state.
    await compareGoldenWhenSettled(
      EMPTY_EXPECTED,
      () => captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
  }, 60_000)

  it('builds a reordered fallback chain from the live catalog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-chain'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '新建备用链' }).click()
    await dialog.getByRole('button', { name: '添加模型' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '添加模型' }).click()
    await dialog.getByRole('button', { name: '添加模型' }).click()
    await dialog.getByRole('button', { name: '添加模型' }).click()
    // Reorder: the last target moves ahead of the middle one, then the
    // original first target is dropped.
    await dialog.getByRole('button', { name: '上移' }).nth(2).click()
    await dialog.getByRole('button', { name: '删除模型' }).nth(0).click()
    await dialog.getByRole('textbox', { name: '名称' }).fill('兜底链')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存。', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('兜底链').waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('route-1:')
    expect(document).toContain('兜底链')
  }, 60_000)

  it('creates a profile allowing the model and the chain', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-profile'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    // The saved chain row proves the pushed reload landed, so the editor that
    // opens next fences against the fresh revision instead of the stale one.
    await dialog.getByText('兜底链').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '新建方案' }).click()
    await dialog.getByText('先允许至少一个模型或备用链，再选择默认目标。').waitFor({ timeout: 10_000 })
    await expect.poll(
      async () => dialog.getByRole('button', { name: '保存', exact: true }).isEnabled(),
      { timeout: 10_000 },
    ).toBe(false)
    // The first catalog model plus the chain, then the chain as default target.
    await dialog.locator('input[type="checkbox"]').nth(0).check()
    await dialog.getByRole('checkbox', { name: /兜底链/ }).check()
    await dialog.getByLabel('默认目标').selectOption('route:route-1')
    await dialog.getByRole('textbox', { name: '名称' }).fill('专注')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The row summary is the reliable post-save signal: it renders only after
    // the pushed reload, where a saved notice could be a leftover.
    await dialog.getByText('允许 1 个模型、1 条备用链。').waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('profile-1:')
    expect(document).toContain('专注')
  }, 60_000)

  it('locks the referenced chain and records the default profile choice', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-configured'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByText('允许 1 个模型、1 条备用链。').waitFor({ timeout: 10_000 })
    // The chain is referenced by the profile, so its delete is refused.
    const chainRemove = dialog.getByRole('button', { name: '删除', exact: true }).nth(0)
    await expect.poll(async () => chainRemove.isEnabled(), { timeout: 10_000 }).toBe(false)
    expect(await chainRemove.getAttribute('title')).toBe('仍有方案引用这条备用链，请先在其中取消。')
    // Choosing the new profile as the default writes the document.
    await dialog.getByLabel('新会话默认方案').selectOption('profile-1')
    await dialog.getByText('已保存。', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('默认', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('defaultProfile: profile-1')
    await compareGoldenWhenSettled(
      CONFIGURED_EXPECTED,
      () => captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(async () => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it('offers the configured profiles on the new-session hero and starts a session on the pick', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-policy-hero'))
    const heroRow = page.locator('[class*="heroWorkspaceRow"]')
    await heroRow.waitFor({ timeout: 10_000 })
    // No session is current, so the chip shows the deployment default the
    // next session would receive.
    const chip = page.getByRole('button', { name: '模型方案，当前 专注' })
    await chip.waitFor({ timeout: 10_000 })
    await compareGoldenWhenSettled(
      HERO_EXPECTED,
      () => captureStableAria(page, '[class*="heroWorkspaceRow"]', scaffold.workspaceCwd),
      MODE,
    )

    await chip.click()
    const item = page.getByRole('menuitem', { name: '不限制', exact: true })
    await item.waitFor({ timeout: 10_000 })
    await item.click()
    // The pick starts a distinct session carrying that profile, and the chip
    // reconciles onto it once it becomes current.
    await page.getByRole('button', { name: '模型方案，当前 不限制' }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
