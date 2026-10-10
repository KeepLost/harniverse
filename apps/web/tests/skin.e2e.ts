// Web e2e scenario: the Appearance section and the custom-skin feature. The
// real composition (the shipped dsh-base and dsh-web-app bundles over a temp
// world) serves a skin library beside the isolated harness home; the browser
// opens Settings → 外观, picks a skin, sets an accent, uploads a wallpaper,
// turns on a glass material, and imports and removes a pack. A reload checks
// that the skin is painted before the client mounts and never flashes back
// to the default palette while the presenter takes over. Zero model calls.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { builtinSkin } from '../../../packages/host/skin-library/src/palette.ts'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skin', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const MODE = webSnapshotMode()

/** A 1×1 PNG: the smallest real image the library accepts. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** One observation of the body's inline skin tokens. */
interface ProbeEntry {
  boot: string | null
  base: string
}

/** A minimal native pack in the dark scheme. */
const PACK = {
  format: 'harniverse.skin',
  version: 1,
  id: 'e2e-pack',
  name: { zh: '测试皮肤包', en: 'E2E Pack' },
  author: 'e2e',
  colorScheme: 'dark',
  accent: '#c026d3',
  tokens: {
    '--dsw-accent': '#c026d3',
    '--dsw-alias-bg-base': '#120f1a',
    '--dsw-alias-bg-layer-1': '#1c1726',
    '--dsw-alias-label-primary': '#f6effa',
    '--dsw-alias-label-secondary': '#b9a9c9',
    '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.07)',
    '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
  },
}

/** Token value a built-in skin defines. */
function paletteToken(id: string, token: string): string {
  const value = builtinSkin(id)?.tokens[token]
  if (value === undefined) throw new Error(`built-in skin ${id} defines no ${token}`)
  return value
}

describe('web e2e: appearance section and custom skins', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    // Record every observable change of the body's inline tokens from the first
    // parser tick on, so a reload can prove the skin never flashes back.
    await page.addInitScript(() => {
      const probe: ProbeEntry[] = []
      ;(window as unknown as { __skinProbe: typeof probe }).__skinProbe = probe
      new MutationObserver(() => {
        const { body } = document
        if (body === null) return
        probe.push({
          boot: body.getAttribute('data-ds-boot-tokens'),
          base: body.style.getPropertyValue('--dsw-alias-bg-base'),
        })
      }).observe(document, { attributes: true, subtree: true, childList: true, attributeFilter: ['style', 'data-ds-boot-tokens'] })
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Open Settings on the Appearance section. */
  async function openAppearance(): Promise<Locator> {
    if (await page.getByRole('dialog', { name: '设置' }).count() === 0) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
    }
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '外观', exact: true }).click()
    await dialog.getByRole('radiogroup', { name: '皮肤' }).waitFor({ timeout: 10_000 })
    return dialog
  }

  /** The inline or inherited value of a custom property on the body. */
  function bodyToken(name: string): Promise<string> {
    return page.evaluate(token => getComputedStyle(document.body).getPropertyValue(token).trim(), name)
  }

  /** The Host's persisted settings document. */
  async function persistedSettings(): Promise<string> {
    return await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
  }

  /** Pick a file in the chooser a button opens. */
  async function chooseFile(button: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()])
    await chooser.setFiles(file)
  }

  it('lists the color-mode, font-size and skin rows in the Appearance section', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skin-section'))
    await openAppearance()
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('applies a skin live and persists it across a reload without a default-palette flash', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skin-apply'))
    const dialog = await openAppearance()
    const nebula = dialog.getByRole('radio', { name: /^星云紫/u })
    await nebula.click()
    expect(await nebula.getAttribute('aria-checked')).toBe('true')
    const base = paletteToken('nebula', '--dsw-alias-bg-base')
    await expect.poll(() => bodyToken('--dsw-alias-bg-base'), { timeout: 10_000 }).toBe(base)
    expect(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    // The color-mode cubes show no selection while a skin is the preference.
    expect(await dialog.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed')).toBe('false')
    await expect.poll(persistedSettings, { timeout: 10_000 }).toMatch(/preference: ['"]?skin:nebula['"]?/u)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const probe = await page.evaluate(() => (window as unknown as { __skinProbe: ProbeEntry[] }).__skinProbe)
    const painted = probe.findIndex(entry => entry.base === base)
    expect(painted, 'the boot script paints the skin tokens').toBeGreaterThanOrEqual(0)
    expect(probe[painted]?.boot, 'the boot script names what it painted').toContain('--dsw-alias-bg-base')
    const flashes = probe.slice(painted).filter(entry => entry.base !== base)
    expect(flashes, 'the skin never flashes back while the presenter adopts it').toEqual([])
    // The presenter adopted the handed-over names and removed the marker.
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-boot-tokens')), { timeout: 10_000 }).toBe(false)
    expect(await bodyToken('--dsw-alias-bg-base')).toBe(base)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('overrides the accent and restores the skin accent', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skin-accent'))
    const dialog = await openAppearance()
    await dialog.getByRole('button', { name: '强调色 #f97316' }).click()
    await expect.poll(() => bodyToken('--dsw-accent'), { timeout: 10_000 }).toBe('#f97316')
    // The inline reference-chip wash is part of the accent family: it follows the override and returns with it.
    await expect.poll(() => bodyToken('--dsw-accent-chip'), { timeout: 10_000 }).toContain('#f97316')
    await expect.poll(persistedSettings, { timeout: 10_000 }).toMatch(/accent: ['"]?#f97316['"]?/u)
    await dialog.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => bodyToken('--dsw-accent'), { timeout: 10_000 }).toBe(paletteToken('nebula', '--dsw-accent'))
    await expect.poll(() => bodyToken('--dsw-accent-chip'), { timeout: 10_000 })
      .toContain(paletteToken('nebula', '--dsw-accent'))
  }, 60_000)

  it('stores an uploaded wallpaper, paints it behind the frame, and turns on a glass material', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skin-wallpaper'))
    const dialog = await openAppearance()
    expect(await bodyToken('--dsw-material-panel-filter')).toBe('none')
    await chooseFile(dialog.getByRole('button', { name: '上传壁纸' }), { name: 'wall.png', mimeType: 'image/png', buffer: PNG })
    const hash = createHash('sha256').update(PNG).digest('hex')
    await dialog.getByRole('button', { name: /^壁纸 1/u }).waitFor({ timeout: 15_000 })
    // The library keeps the bytes content-addressed under the harness home.
    expect(await readdir(join(scaffold.harnessHome, 'skins', 'wallpapers'))).toEqual([`${hash}.png`])
    await expect.poll(persistedSettings, { timeout: 10_000 }).toContain(hash)
    await expect.poll(() => page.locator('[data-backdrop="wallpaper"]').count(), { timeout: 15_000 }).toBe(1)

    await dialog.getByRole('radio', { name: '磨砂' }).click()
    await expect.poll(() => bodyToken('--dsw-material-panel-filter'), { timeout: 10_000 }).toContain('blur(')
    await dialog.getByRole('radio', { name: '关闭' }).click()
    await expect.poll(() => bodyToken('--dsw-material-panel-filter'), { timeout: 10_000 }).toBe('none')

    // The wallpaper survives a reload.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => page.locator('[data-backdrop="wallpaper"]').count(), { timeout: 15_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('imports a pack, selects it, rejects a broken one, and falls back when the active pack is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skin-pack'))
    const dialog = await openAppearance()
    const importButton = dialog.getByRole('button', { name: '导入皮肤包' })
    await chooseFile(importButton, { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') })
    await dialog.getByText('这个皮肤包没有通过检查：').waitFor({ timeout: 15_000 })
    expect(await readdir(join(scaffold.harnessHome, 'skins', 'packs')).catch(() => [])).toEqual([])

    await chooseFile(importButton, { name: 'pack.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(PACK)) })
    const card = dialog.getByRole('radio', { name: /^测试皮肤包/u })
    await card.waitFor({ timeout: 15_000 })
    expect(await readdir(join(scaffold.harnessHome, 'skins', 'packs'))).toEqual(['e2e-pack.json'])
    await card.click()
    await expect.poll(() => bodyToken('--dsw-alias-bg-base'), { timeout: 10_000 }).toBe('#120f1a')
    await expect.poll(persistedSettings, { timeout: 10_000 }).toMatch(/preference: ['"]?skin:e2e-pack['"]?/u)

    await dialog.getByRole('button', { name: '删除“测试皮肤包”' }).click()
    await expect.poll(() => dialog.getByRole('radio', { name: /^测试皮肤包/u }).count(), { timeout: 15_000 }).toBe(0)
    expect(await readdir(join(scaffold.harnessHome, 'skins', 'packs'))).toEqual([])
    // The preference returns to the system color mode.
    await expect.poll(() => dialog.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed and the console clean', async () => {
    expect(tripwire.warnings).toEqual([])
    expect((await readdir(SNAPSHOT_DIR)).sort()).toEqual(['section.expected.md'])
  })
})
