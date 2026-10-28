// Web e2e scenario: the long-lived connection budget. The browser's
// per-origin HTTP/1.1 pool holds roughly six connections shared across tabs,
// so any per-entity stream family that opens one connection per watched
// directory, terminal, or browser page eventually starves every ordinary
// request (the "signal timed out" incident class). This scenario pins the
// contract that kills that class: with workbench file watching live and a
// terminal attached, the page holds exactly three event WebSockets (mux,
// host, and the entity-stream downlink) and issues zero hanging GETs to the
// legacy per-entity stream paths — while a file read still completes.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedBlankSession, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SESSION_ID = 'stream-budget-web-e2e'
const LEGACY_STREAM_MARKERS = ['/api/events.terminal', '/api/events.hold', '/api/events.browser', '/api/workspace.files.watch']

/** Live WebSocket URLs to /api event paths, from CDP Network tracking. */
function webSocketTracker(): { sockets: Set<string>; created: number; legacyRequests: string[] } {
  return { sockets: new Set<string>(), created: 0, legacyRequests: [] }
}

describe('web e2e: stream connection budget', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-stream-budget-home-'))
    scaffold = await launchWebScaffold({ harnessHome })
    // connectFreshWorkspace connects <workspaceCwd>/workspace as the Workspace root.
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guide.md'), '# Guide\n\nbudget proof\n')
    await writeFile(join(cwd, 'tracked.ts'), 'export const state = 3\n')
    await seedBlankSession(scaffold, SESSION_ID, cwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('holds a constant three event WebSockets under watch and terminal load, with no legacy stream GETs', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stream-budget'))
    const tracker = webSocketTracker()
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    const closed = new Set<string>()
    session.on('Network.webSocketCreated', (event) => {
      tracker.created += 1
      if (event.url.includes('/api/events')) tracker.sockets.add(event.url)
    })
    session.on('Network.webSocketClosed', (event) => { closed.add(event.requestId) })
    session.on('Network.requestWillBeSent', (event) => {
      if (LEGACY_STREAM_MARKERS.some(marker => event.request.url.includes(marker))) {
        tracker.legacyRequests.push(event.request.url)
      }
    })

    // A reload re-establishes every carrier with tracking live, so the count
    // covers the boot set — not just sockets opened after attaching.
    await page.reload({ waitUntil: 'load' })
    const workbench = page.getByRole('complementary', { name: 'Workspace workbench' })
    if (await workbench.count() === 0) {
      // The affordance's accessible name differs by surface (hero chip vs
      // sidebar); either way it is the only "open workbench" control.
      await page.getByRole('button', { name: /Open (workspace )?workbench/u }).first().click()
    }
    await workbench.waitFor({ timeout: 15_000 })

    // Directory watches: the root watch rides boot; expanding docs adds the
    // second directory watch — both are substreams on the downlink.
    await workbench.getByRole('tab', { name: 'Files', exact: true }).click()
    const navigation = workbench.getByRole('tabpanel')
    await navigation.getByRole('button', { name: 'docs', exact: true }).click()
    await expect.poll(() => (
      navigation.getByRole('button', { name: 'docs', exact: true }).getAttribute('aria-expanded')
    ), { timeout: 10_000 }).toBe('true')

    // A terminal attachment plus its window hold — two more substreams.
    await workbench.getByRole('tab', { name: 'Terminal' }).click()
    await page.getByRole('button', { name: 'New terminal' }).click()
    await expect.poll(() => (
      page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
    ), { timeout: 30_000 }).toMatch(/[$#]/u)

    // Let any accidental per-entity connection surface before asserting.
    await page.waitForTimeout(500)
    const eventPaths = new Set<string>()
    for (const url of tracker.sockets) {
      const path = new URL(url).pathname
      if (path.startsWith('/api/events')) eventPaths.add(path)
    }
    expect([...eventPaths].sort()).toEqual(['/api/events.host', '/api/events.mux', '/api/events.streams'])
    expect(tracker.legacyRequests).toEqual([])

    // The starvation probe: an ordinary read still completes promptly while
    // every watch and terminal stream is live.
    await workbench.getByRole('tab', { name: 'Files', exact: true }).click()
    await navigation.getByRole('button', { name: /guide\.md$/ }).click()
    const preview = page.getByRole('region', { name: 'Workspace file preview' })
    await preview.getByRole('heading', { name: 'Guide', exact: true }).waitFor({ timeout: 10_000 })

    expect(closed.size).toBeLessThanOrEqual(tracker.created)
  }, 120_000)
})
