// Web e2e scenario: the phone form factor (390x844, the narrowest surface the
// frame claims). One page, one blank session, zero model calls — every
// assertion is geometry the CSS owes at that width: the frame publishes
// `phone`, the composer row stacks instead of colliding, the stats line wraps
// instead of clipping, an expanded sidebar overlays the center column, the two
// footer triggers share one left edge, the settings panel is a full-bleed
// sheet with a horizontal nav, and the eight-column schedule table becomes a
// card per row.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedBlankSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

/** iPhone-class portrait viewport: the narrowest width the phone form claims. */
const PHONE = { width: 390, height: 844 }
const SESSION_ID = 'phone-form-web-e2e'

/**
 * Read one resolved style value off the first match of a selector.
 * @param page - page under test.
 * @param selector - CSS selector to resolve.
 * @param property - style property to read.
 * @param pseudo - optional pseudo-element to read instead of the element.
 * @returns the computed value.
 */
async function styleOf(page: Page, selector: string, property: string, pseudo?: string): Promise<string> {
  return await page.evaluate(([sel, prop, pseudoElement]) => {
    const node = document.querySelector(sel)
    if (node === null) throw new Error(`no element matches ${sel}`)
    return getComputedStyle(node, pseudoElement === '' ? null : pseudoElement).getPropertyValue(prop)
  }, [selector, property, pseudo ?? ''] as const)
}

/**
 * Drive the sidebar to one state so each case starts from a known frame,
 * whatever the previous case left behind.
 * @param page - page under test.
 * @param want - `drawer` for the expanded overlay, `rail` for the collapsed rail.
 */
async function sidebar(page: Page, want: 'drawer' | 'rail'): Promise<void> {
  const frame = page.locator('[data-viewport]').first()
  const open = await frame.getAttribute('data-sidebar-drawer') === 'true'
  if (open === (want === 'drawer')) return
  await page.getByRole('button', { name: open ? '收起侧边栏' : '打开侧边栏' }).click()
  await expect.poll(() => frame.getAttribute('data-sidebar-drawer'), { timeout: 10_000 })
    .toBe(want === 'drawer' ? 'true' : null)
}

describe('web e2e: phone form factor', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let harnessHome: string

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-phone-home-'))
    scaffold = await launchWebScaffold({ harnessHome })
    const cwd = join(scaffold.workspaceCwd, 'phone-form')
    await mkdir(cwd, { recursive: true })
    await seedBlankSession(scaffold, SESSION_ID, cwd)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: PHONE, locale: ZH_BROWSER_LOCALE })
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

  it('publishes the phone form and lays the frame out without a horizontal overflow', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-frame'))
    const frame = page.locator('[data-viewport]').first()
    await frame.waitFor({ timeout: 10_000 })
    expect(await frame.getAttribute('data-viewport')).toBe('phone')
    // The sidebar auto-collapses to its rail below 1024px and the details
    // column closes, so the frame fits the viewport exactly.
    expect(await frame.getAttribute('data-sidebar-drawer')).toBeNull()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
  })

  it('stacks the composer row instead of overlapping its two groups', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-composer'))
    const tools = page.locator('[class*="tools"]').first()
    const trailing = page.locator('[class*="trailing"]').first()
    await tools.waitFor({ timeout: 15_000 })
    const left = (await tools.boundingBox())!
    const right = (await trailing.boundingBox())!
    // Either the groups sit side by side or the row wrapped; what must never
    // happen is the two overlapping.
    const disjoint = left.x + left.width <= right.x + 1 || left.y + left.height <= right.y + 1
    expect(disjoint).toBe(true)
    // Both groups stay inside the viewport: nothing is pushed out of reach.
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(right.x + right.width).toBeLessThanOrEqual(PHONE.width + 1)
  })

  it('wraps the stats line instead of clipping it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-stats'))
    const statsSelector = '[class*="statsLine"], [class*="StatsLine"]'
    const present = await page.locator(statsSelector).count()
    if (present === 0) return
    expect(await styleOf(page, statsSelector, 'white-space')).toBe('normal')
    expect(await styleOf(page, statsSelector, 'text-overflow')).toBe('clip')
    const clipped = await page.evaluate((sel) => {
      const node = document.querySelector(sel)!
      return node.scrollWidth > node.clientWidth + 1
    }, statsSelector)
    expect(clipped).toBe(false)
  })

  it('overlays the sidebar over the center column and dismisses it from the scrim', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-sidebar'))
    const frame = page.locator('[data-viewport]').first()
    await sidebar(page, 'drawer')
    // The overlay is wider than the rail it replaced and stops short of the
    // right edge so the center column stays visible behind it.
    const drawer = (await page.locator('[class*="sidebarCol"]').first().boundingBox())!
    expect(drawer.width).toBeGreaterThan(200)
    expect(drawer.width).toBeLessThan(PHONE.width)

    // The scrim owns exactly the strip the drawer leaves exposed, so the
    // tap-outside gesture cannot land on the sidebar it is dismissing.
    const dismiss = page.getByRole('button', { name: '关闭侧栏遮罩' })
    const scrim = (await dismiss.boundingBox())!
    expect(Math.abs(scrim.x - (drawer.x + drawer.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(scrim.x + scrim.width - PHONE.width)).toBeLessThanOrEqual(1)
    await dismiss.click()
    await expect.poll(() => frame.getAttribute('data-sidebar-drawer'), { timeout: 10_000 }).toBeNull()
  })

  it('aligns the two sidebar footer triggers on one left edge', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-footer'))
    await sidebar(page, 'drawer')
    const schedules = page.getByRole('button', { name: '打开定时任务' })
    const settings = page.getByRole('button', { name: '设置', exact: true })
    await schedules.waitFor({ timeout: 10_000 })
    const scheduleBox = (await schedules.boundingBox())!
    const settingsBox = (await settings.boundingBox())!
    // Same box: the schedule trigger used to center its content beside a
    // left-aligned Settings row, which read as two unrelated controls.
    expect(Math.abs(scheduleBox.x - settingsBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(scheduleBox.width - settingsBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(scheduleBox.height - settingsBox.height)).toBeLessThanOrEqual(1)
    expect(scheduleBox.y).toBeLessThan(settingsBox.y)
    await sidebar(page, 'rail')
  })

  it('opens the settings panel as a full-bleed sheet with a horizontal nav', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-settings'))
    await sidebar(page, 'rail')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 15_000 })
    const panel = (await dialog.boundingBox())!
    // A sheet, not an 800px card cropped by the viewport.
    expect(panel.width).toBeGreaterThanOrEqual(PHONE.width - 1)
    expect(panel.height).toBeGreaterThanOrEqual(PHONE.height - 1)

    // The nav rail becomes a tab strip: its entries share a row.
    const general = dialog.getByRole('button', { name: '通用设置' })
    await general.waitFor({ timeout: 10_000 })
    const navBoxes = await dialog.locator('[class*="navCell"]').evaluateAll(nodes => nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y }
    }))
    expect(navBoxes.length).toBeGreaterThan(1)
    expect(navBoxes.every(box => Math.abs(box.y - navBoxes[0]!.y) <= 1)).toBe(true)
    expect(navBoxes[1]!.x).toBeGreaterThan(navBoxes[0]!.x)

    // A contributed row gets the full content column instead of ~100px.
    await general.click()
    const cube = dialog.locator('[class*="themeCube"]').first()
    await cube.waitFor({ timeout: 10_000 })
    const cubeBox = (await cube.boundingBox())!
    expect(cubeBox.width).toBeGreaterThan(PHONE.width * 0.7)

    await dialog.getByRole('button', { name: '关闭' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  })

  it('renders each schedule table row as a card of labelled values', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-schedules'))
    await sidebar(page, 'rail')
    await page.getByRole('button', { name: '打开定时任务' }).click()
    const view = page.getByRole('region', { name: '定时任务' })
    await view.waitFor({ timeout: 15_000 })

    // Create one schedule so a row exists to inspect. A 30-minute one-shot
    // delay never dispatches during the scenario, so the card stays still.
    await view.getByRole('button', { name: '新建任务' }).click()
    const drawer = page.getByRole('dialog', { name: '新建定时任务' })
    await drawer.waitFor({ timeout: 10_000 })
    await drawer.getByLabel('指令').fill('手机档卡片校验')
    await drawer.getByLabel('执行规则').selectOption('after')
    await drawer.getByLabel('延迟（分钟）').fill('30')
    await drawer.getByRole('button', { name: '保存' }).click()
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 })
    const row = view.locator('[data-schedule-row]').first()
    await row.waitFor({ timeout: 15_000 })

    // The row is a card, not a table row, and each cell prints the header the
    // hidden thead used to carry.
    expect(await row.evaluate(node => getComputedStyle(node).display)).toBe('block')
    expect(await view.locator('thead').evaluate(node => getComputedStyle(node).display)).toBe('none')
    const labelled = await row.locator('td').first().evaluate(node => getComputedStyle(node, '::before').content)
    expect(labelled).toContain('ID')
    // No horizontal escape: eight nowrap columns used to force a scroller.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)

    await row.getByRole('button', { name: '删除' }).click()
    await view.getByText('还没有任何定时任务。').waitFor({ timeout: 10_000 })
    await view.getByRole('button', { name: '返回会话' }).click()
    await page.getByRole('region', { name: '定时任务' }).waitFor({ state: 'hidden', timeout: 10_000 })
  })
})
