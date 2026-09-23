// Web e2e scenario: the browser panel's defining claim — the page is fetched
// and rendered by the HOST, not by the user's browser. Nothing in a unit suite
// can establish that, because the claim is about which process opened the
// socket. This file settles it with a throwaway origin the scenario itself
// serves: the test server records every request it receives, and Playwright
// records every request the user's page makes. The panel is correct only when
// the server saw the document and the user's page did not.
//
// The same origin also refuses to be framed (`X-Frame-Options: DENY` and
// `frame-ancestors 'none'`), which the previous iframe carrier could not have
// displayed at all, and it echoes host-side interaction back to the server, so
// forwarded clicks and keystrokes are observed where they land rather than
// inferred from the panel's own state.
//
// The lane relaxes two shipped defaults through host-browser.overlay.yml
// (Chromium's sandbox cannot start as root, and loopback destinations are
// refused by default); everything else is the shipped composition.
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedBlankSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./host-browser.overlay.yml', import.meta.url))
const SESSION_ID = 'browser-panel-web-e2e'
/** Title the host browser must parse out of the served document. */
const PAGE_TITLE = 'Harniverse host page'
/** Text painted large enough to survive JPEG screencast compression. */
const MARKER = 'HOST-EGRESS-OK'
/** iPhone-class portrait viewport: the narrowest width the phone form claims. */
const PHONE = { width: 390, height: 844 }

/**
 * Make the seeded session current: a fresh page starts session-less, and the
 * workbench chip renders only with a resident session.
 * @param page - page under test.
 */
async function selectSeededSession(page: Page): Promise<void> {
  const sessionRow = page.locator('[role="treeitem"]').nth(1)
  await sessionRow.waitFor({ timeout: 15_000 })
  await sessionRow.click()
  // The drawer covers the composer (and its workbench chip) until closed.
  await page.keyboard.press('Escape')
}

/** A served origin that records what reached it. */
interface Origin {
  /** Absolute `http://127.0.0.1:<port>/` base. */
  readonly url: string
  /** Request paths in arrival order. */
  readonly hits: string[]
  /** Stop listening. */
  close(): Promise<void>
}

/**
 * Serve one unframeable page that reports host-side interaction back to itself.
 * @returns the listening origin.
 */
async function serveOrigin(): Promise<Origin> {
  const hits: string[] = []
  // The click listener is on the document and the page fills the viewport: a
  // body-level handler misses clicks that land in a collapsed margin, which is
  // geometry noise rather than anything about the panel.
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title>
<style>html,body{height:100%;margin:0}body{font:700 48px/1.2 sans-serif;background:#fff;color:#000}
input{font:400 32px/1.2 sans-serif;width:90%}</style></head>
<body>
<p style="margin:0">${MARKER}</p>
<input id="probe" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
<script>document.addEventListener('click',()=>{fetch('/clicked');document.getElementById('probe').focus()})</script>
</body></html>`
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if (!(request.url ?? '').startsWith('/?') && request.url !== '/') {
      response.writeHead(204, { 'access-control-allow-origin': '*' }).end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // An iframe carrier renders nothing under either header; a host-side page
      // process is unaffected, so the rendered frame is itself evidence.
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    }).end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

/**
 * Type a destination into the panel's address bar and submit it.
 * @param page - page under test.
 * @param url - destination handed to the host.
 */
async function navigateTo(page: Page, url: string): Promise<void> {
  const address = page.getByLabel('Address')
  await address.fill(url)
  await address.press('Enter')
}

/**
 * Read the length of the rendered frame's data URL.
 * @param page - page under test.
 * @returns the `src` length, or 0 when no surface is mounted.
 */
async function frameBytes(page: Page): Promise<number> {
  return await page.evaluate(
    () => document.querySelector<HTMLImageElement>('[role="application"] img')?.src.length ?? 0,
  )
}

describe('web e2e: host browser panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let origin: Origin
  let tripwire: ReturnType<typeof watchConsole>
  let harnessHome: string
  /** Every request the USER's browser made, so host-only traffic is provable. */
  const clientRequests: string[] = []

  beforeAll(async () => {
    origin = await serveOrigin()
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-browser-home-'))
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    const cwd = join(scaffold.workspaceCwd, 'browser-panel')
    await mkdir(cwd, { recursive: true })
    await seedBlankSession(scaffold, SESSION_ID, cwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', (request) => { clientRequests.push(request.url()) })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Open workspace workbench' }).click()
    const workbench = page.getByRole('complementary', { name: 'Workspace workbench' })
    await workbench.getByRole('tab', { name: 'Browser' }).click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await origin?.close()
    await rm(harnessHome, { recursive: true, force: true })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows its guidance instead of an opaque surface before a page exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-browser-empty'))
    const hint = page.getByText('Type a URL above', { exact: false })
    await hint.waitFor({ timeout: 20_000 })
    // The panel's sibling defect class: a mounted surface painting over the
    // guidance leaves an opaque rectangle with no way to discover the panel.
    const onTop = await page.evaluate(() => {
      const node = [...document.querySelectorAll('p')]
        .find(candidate => candidate.textContent?.includes('Type a URL above') ?? false)
      if (node === undefined) throw new Error('empty hint not found')
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === node || node.contains(hit)
    })
    expect(onTop).toBe(true)
    expect(await page.locator('[role="application"]').count()).toBe(0)
  })

  it('fetches and renders the page from the host, not from this browser', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-browser-host-egress'))
    await navigateTo(page, origin.url)
    // A screencast frame is a complete JPEG: any real paint dwarfs an empty src.
    await expect.poll(() => frameBytes(page), { timeout: 60_000 }).toBeGreaterThan(2000)
    // The host parsed the document, not just the bytes: the tab carries the
    // <title> the server sent, which only a real page process produces.
    await page.getByRole('tab', { name: PAGE_TITLE }).waitFor({ timeout: 20_000 })
    expect(origin.hits).toContain('/')
    // The decisive half: the user's browser never touched the origin. The
    // server was reached, so the request came from the harness host.
    expect(clientRequests.filter(url => url.startsWith(origin.url))).toEqual([])
  }, 120_000)

  it('forwards clicks and keystrokes to the host page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-browser-input'))
    const surface = page.locator('[role="application"] img')
    await surface.click({ position: { x: 40, y: 40 } })
    await expect.poll(() => origin.hits.includes('/clicked'), { timeout: 30_000 }).toBe(true)
    await page.keyboard.type('hi')
    // The page echoes its own input value, so the characters are observed where
    // they were delivered rather than inferred from the panel's state.
    await expect.poll(
      () => origin.hits.some(hit => hit.startsWith('/typed') && hit.endsWith('hi')),
      { timeout: 30_000 },
    ).toBe(true)
  }, 90_000)

  it('refuses a destination the host policy rejects', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-browser-policy'))
    await navigateTo(page, 'file:///etc/passwd')
    // Policy lives on the host now: the client cannot be talked out of it, and
    // the refusal is reported as the panel's own alert.
    const alert = page.getByRole('alert')
    await alert.first().waitFor({ timeout: 20_000 })
    await expect.poll(() => alert.first().textContent(), { timeout: 10_000 }).toMatch(/file:/iu)
    expect(origin.hits).not.toContain('/etc/passwd')
  }, 60_000)

  it('retires the surface and releases the host browser when the page closes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-browser-close'))
    await page.getByRole('button', { name: 'Close page' }).click()
    await page.getByText('Type a URL above', { exact: false }).waitFor({ timeout: 20_000 })
    expect(await page.locator('[role="application"]').count()).toBe(0)
  }, 60_000)

  describe('phone form', () => {
    let phone: Page

    beforeAll(async () => {
      phone = await browser.newPage({ viewport: PHONE, locale: 'en-US' })
      await phone.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await phone.getByRole('button', { name: 'Open sidebar' }).click()
      await selectSeededSession(phone)
      await phone.getByRole('button', { name: 'Open workspace workbench' }).click()
      const workbench = phone.getByRole('complementary', { name: 'Workspace workbench' })
      await workbench.getByRole('tab', { name: 'Browser' }).click()
    }, 120_000)

    afterAll(async () => { await phone?.close() })

    it('keeps its controls thumb-sized and its column free of overflow', async () => {
      onTestFailed(() => saveFailureShot(phone, 'web-e2e-browser-phone'))
      const address = phone.getByLabel('Address')
      await address.waitFor({ timeout: 20_000 })
      expect(await phone.evaluate(
        () => document.querySelector('[data-viewport]')?.getAttribute('data-viewport'),
      )).toBe('phone')
      const box = (await address.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      const reload = (await phone.getByRole('button', { name: 'Reload' }).boundingBox())!
      expect(reload.height).toBeGreaterThanOrEqual(44)
      expect(reload.width).toBeGreaterThanOrEqual(44)
      const overflow = await phone.evaluate(() => {
        const view = document.querySelector('[class*="view"]')
        return view === null ? 0 : view.scrollWidth - view.clientWidth
      })
      expect(overflow).toBeLessThanOrEqual(0)
    }, 60_000)
  })
})
