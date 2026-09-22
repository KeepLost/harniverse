// Web e2e scenario: the terminal panel as a user meets it. Every assertion
// here is something jsdom structurally cannot answer — whether the guidance
// text is actually visible, what the rendered cells resolve to, how many
// columns the shell is given, and whether a touch surface can send Ctrl-C.
// The panel's unit suite runs under jsdom, which has no layout engine and
// resolves none of the surface's declared presentation properties; a green
// suite there was compatible with a shipped black void, so this file owns the
// appearance and form-factor contract instead.
//
// One scaffold, one workspace, zero model calls: the terminal rides the
// authenticated terminal-controller streams, not the agent loop. Two pages
// share it — a desktop page for the appearance and column contract and a phone
// page for the touch form — and the PTYs both open are closed by the panel's
// own close verb before teardown.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedBlankSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

/** iPhone-class portrait viewport: the narrowest width the phone form claims. */
const PHONE = { width: 390, height: 844 }
const SESSION_ID = 'terminal-panel-web-e2e'

/** A shell prompt has rendered once the workspace path appears in the screen. */
const PROMPT_TIMEOUT = 30_000

/**
 * Open the terminal panel from the sidebar footer trigger.
 * @param page - page under test.
 * @param label - accessible name of the trigger in the page's locale.
 */
async function openPanel(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label }).click()
}

/**
 * Read the rendered cell rows xterm painted.
 * @param page - page under test.
 * @returns the concatenated text of the screen.
 */
async function screenText(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

/**
 * Start one terminal and wait until its shell has printed a prompt.
 * @param page - page under test.
 * @param newTerminal - accessible name of the create control.
 */
async function startTerminal(page: Page, newTerminal: string): Promise<void> {
  await page.getByRole('button', { name: newTerminal }).click()
  await expect.poll(() => screenText(page), { timeout: PROMPT_TIMEOUT })
    .toMatch(/[$#]/u)
}

describe('web e2e: terminal panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let harnessHome: string

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-terminal-home-'))
    scaffold = await launchWebScaffold({ harnessHome })
    const cwd = join(scaffold.workspaceCwd, 'terminal-panel')
    await mkdir(cwd, { recursive: true })
    await seedBlankSession(scaffold, SESSION_ID, cwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await openPanel(page, 'Open the terminal panel')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows its guidance instead of an opaque screen before a terminal exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-empty'))
    const hint = page.getByText('No terminals yet', { exact: false })
    await hint.waitFor({ timeout: 15_000 })
    // The regression this file exists for: the hint was rendered, visible, and
    // painted over by xterm's opaque screen, leaving a black void with a
    // cursor. Hit-testing its own center is the only assertion that catches it.
    const onTop = await page.evaluate(() => {
      const node = [...document.querySelectorAll('p')]
        .find(candidate => candidate.textContent?.includes('No terminals yet') ?? false)
      if (node === undefined) throw new Error('empty hint not found')
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === node || node.contains(hit)
    })
    expect(onTop).toBe(true)
    // No surface means no terminal is being rendered at all.
    expect(await page.locator('.xterm').count()).toBe(0)
  })

  it('renders a live shell whose prompt and echo reach the screen', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-live'))
    await startTerminal(page, 'New terminal')
    await page.getByLabel('Terminal output').click()
    await page.keyboard.type('echo harniverse-terminal-ok')
    await expect.poll(() => screenText(page), { timeout: 15_000 })
      .toContain('echo harniverse-terminal-ok')
    await page.keyboard.press('Enter')
    await expect.poll(() => screenText(page), { timeout: 15_000 })
      .toContain('harniverse-terminal-ok')
  })

  it('takes its cells from the theme rather than xterm defaults', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-appearance'))
    const appearance = await page.evaluate(() => {
      const rows = document.querySelector('.xterm-rows')
      const surface = document.querySelector('[class*="surface"]')
      if (rows === null || surface === null) throw new Error('terminal surface not mounted')
      const cells = getComputedStyle(rows)
      const declared = getComputedStyle(surface)
      return {
        fontFamily: cells.fontFamily,
        fontSize: cells.fontSize,
        color: cells.color,
        viewport: getComputedStyle(document.querySelector('.xterm-viewport')!).backgroundColor,
        declaredBackground: declared.getPropertyValue('--dsh-terminal-bg').trim(),
        declaredFontSize: declared.getPropertyValue('--dsh-terminal-font-size').trim(),
      }
    })
    // xterm's untouched defaults are 15px bare monospace on #000 with #fff
    // text: three values that belong to no palette in this product.
    expect(appearance.fontFamily).toContain('SF Mono')
    expect(appearance.fontSize).toBe('13px')
    expect(appearance.declaredFontSize).toBe('13px')
    expect(appearance.color).not.toBe('rgb(255, 255, 255)')
    expect(appearance.viewport).not.toBe('rgb(0, 0, 0)')
    // The screen paint is the token the stylesheet declares, not a literal.
    expect(appearance.declaredBackground).toBe(appearance.viewport)
  })

  it('gives the shell a usable column count for 80-column output', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-columns'))
    const columns = await page.evaluate(() => {
      const rows = document.querySelector('.xterm-rows')?.children
      if (rows === undefined || rows.length === 0) throw new Error('no rendered rows')
      return { rows: rows.length }
    })
    expect(columns.rows).toBeGreaterThan(10)
    // `tput cols` answers from the PTY, so this asserts the fitted dimensions
    // actually reached the host rather than the browser's own guess. The value
    // is fenced in a marker because the screen text carries the prompt, the
    // echoed command, and wrapping between them.
    await page.getByLabel('Terminal output').click()
    await page.keyboard.type('echo "cols=[$(tput cols)]"')
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const text = await screenText(page)
      const match = /cols=\[(\d+)\]/u.exec(text)
      return match === null ? 0 : Number(match[1])
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(80)
  })

  it('hides the touch key bar where a hardware keyboard can send the sequences', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-keybar-desktop'))
    const bar = page.getByRole('group', { name: 'Control keys' })
    await expect.poll(() => bar.isVisible(), { timeout: 10_000 }).toBe(false)
  })

  it('closes its terminal from the tab affordance', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminal-close'))
    await page.getByRole('button', { name: 'Close this terminal' }).click()
    // Closing the last terminal retires the surface and returns the guidance.
    await page.getByText('No terminals yet', { exact: false }).waitFor({ timeout: 15_000 })
    expect(await page.locator('.xterm').count()).toBe(0)
  })

  describe('phone form', () => {
    let phone: Page
    let phoneTripwire: ReturnType<typeof watchConsole>

    beforeAll(async () => {
      phone = await browser.newPage({ viewport: PHONE, locale: 'en-US' })
      phoneTripwire = watchConsole(phone)
      await phone.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await phone.waitForSelector('[data-viewport]', { timeout: 30_000 })
      await phone.getByRole('button', { name: 'Open sidebar' }).click()
      await openPanel(phone, 'Open the terminal panel')
    }, 120_000)

    afterAll(async () => {
      await phone?.close()
      expect(phoneTripwire.warnings).toEqual([])
      expect(phoneTripwire.pageErrors).toEqual([])
    })

    it('publishes the phone form and keeps the panel inside the viewport', async () => {
      onTestFailed(() => saveFailureShot(phone, 'web-e2e-terminal-phone-frame'))
      const frame = phone.locator('[data-viewport]').first()
      expect(await frame.getAttribute('data-viewport')).toBe('phone')
      const overflow = await phone.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBe(0)
    })

    it('offers the control keys a soft keyboard cannot produce, at a touch size', async () => {
      onTestFailed(() => saveFailureShot(phone, 'web-e2e-terminal-phone-keybar'))
      await startTerminal(phone, 'New terminal')
      const bar = phone.getByRole('group', { name: 'Control keys' })
      await bar.waitFor({ timeout: 15_000 })
      const ctrlC = phone.getByRole('button', { name: 'Ctrl C' })
      const box = (await ctrlC.boundingBox())!
      // Below 44px a control is not reliably hittable with a thumb.
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
      // The bar is only worth having if the sequence reaches the PTY: a
      // sleep interrupted by Ctrl-C returns to a prompt on its own line.
      await phone.getByLabel('Terminal output').click()
      await phone.keyboard.type('sleep 30')
      await phone.keyboard.press('Enter')
      await ctrlC.click()
      await expect.poll(() => screenText(phone), { timeout: 20_000 }).toContain('^C')
    })

    it('narrows the cells and enlarges the controls for the touch form', async () => {
      onTestFailed(() => saveFailureShot(phone, 'web-e2e-terminal-phone-metrics'))
      const declared = await phone.evaluate(() => {
        const surface = document.querySelector('[class*="surface"]')
        if (surface === null) throw new Error('terminal surface not mounted')
        return getComputedStyle(surface).getPropertyValue('--dsh-terminal-font-size').trim()
      })
      expect(declared).toBe('12px')
      const cells = await phone.evaluate(
        () => getComputedStyle(document.querySelector('.xterm-rows')!).fontSize,
      )
      expect(cells).toBe('12px')
      const newTerminal = (await phone.getByRole('button', { name: 'New terminal' }).boundingBox())!
      expect(newTerminal.height).toBeGreaterThanOrEqual(44)
      const close = (await phone.getByRole('button', { name: 'Close this terminal' }).boundingBox())!
      expect(close.height).toBeGreaterThanOrEqual(44)
    })

    it('closes its terminal so the host retains no PTY after the scenario', async () => {
      onTestFailed(() => saveFailureShot(phone, 'web-e2e-terminal-phone-close'))
      await phone.getByRole('button', { name: 'Close this terminal' }).click()
      await phone.getByText('No terminals yet', { exact: false }).waitFor({ timeout: 15_000 })
    })
  })
})
