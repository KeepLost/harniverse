// Web e2e scenario: the resident composer is Chat's surface.
//
// The composer seat is one resident node across view tabs (its textarea keeps
// DOM identity so drafts and focus survive switches), but it only paints on
// Chat: ConversationRoot's stylesheet hides it while a non-Chat view is active
// (see
// packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css),
// unless a pending takeover interaction pins it over the view so the blocked
// agent can still receive its answer. Trajectory declares a full-bleed view
// (`data-conversation-view-fullbleed`): it fills the column and owns its own
// scrollers, so the column's scroller stops scrolling there — and with the
// seat hidden, the ledger, its inspector panes, and the context strip use the
// full height instead of reserving bottom clearance for a floating bar.
//
// What is asserted here is the user-visible fact in a real engine: the card
// and textarea exist on Chat, nothing input-shaped is exposed on Trajectory
// (the hidden subtree leaves the accessibility tree), and the same seat and
// textarea nodes return when the tab flips back. The scroller facts stay from
// the previous geometry contract: Chat reserves its scrollbar gutter
// unconditionally; the full-bleed branch reserves nothing because the view
// owns the scrolling.
//
// The browser is launched WITHOUT Playwright's default `--hide-scrollbars`,
// which stays load-bearing: under that argument a scroll container's bar
// consumes no layout width, so the reserved-band measurements below would
// read 0 and prove nothing. ui-theme's scrollbar.css gives
// `::-webkit-scrollbar` a width, and a bar that occupies layout space is what
// the product actually draws.
//
// Zero model calls: a seeded cold session renders from its log, and switching
// tabs asks the host for nothing. A stray stream would fail loud with
// NO_ADAPTER.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/composer-tab-geometry', import.meta.url))
/**
 * Committed golden of where the composer sits per tab: the scroller's
 * resolved scrollbar behaviour in each state, the seat's resolved display,
 * and whether the resident nodes survived a tab round trip. Absolute card
 * coordinates stay out: they depend on the sidebar's laid-out width and font
 * metrics, so committing them would produce a fixture that has to be
 * re-recorded per platform.
 */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()

/** Long enough that the transcript overflows the lane's 1000px viewport; the scenario asserts the overflow rather than trusting it. */
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'TAB_GEOMETRY',
  title: 'COMPOSER_TAB_GEOMETRY long session',
  turns: 24,
})
const SEED_ID = 'composer-tab-geometry-web-e2e'

/** Viewport widths the scenario measures at: the card capped, and the card shrinking with the column. */
const WIDE_VIEWPORT = { width: 1680, height: 1000 }
const NARROW_VIEWPORT = { width: 800, height: 1000 }

/**
 * Resize to one measurement viewport after the responsive sidebar and center
 * column finish their track transition.
 * @param page - the page under test.
 * @param viewport - the viewport dimensions to apply.
 * @param sidebarCollapsed - the sidebar state expected at this width.
 */
async function setMeasuredViewport(
  page: Page,
  viewport: { width: number; height: number },
  sidebarCollapsed: boolean,
): Promise<void> {
  await page.setViewportSize(viewport)
  await page.locator('[data-sidebar-collapsed="true"]').waitFor({
    state: sidebarCollapsed ? 'attached' : 'detached',
    timeout: 10_000,
  })
  await page.locator('[data-conversation-scroll]').evaluate(async (host) => {
    const deadline = performance.now() + 5_000
    let previous = host.getBoundingClientRect().width
    let stableFrames = 0
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const current = host.getBoundingClientRect().width
      stableFrames = Math.abs(current - previous) < 0.01 ? stableFrames + 1 : 0
      if (stableFrames >= 3) return
      previous = current
    }
    throw new Error('conversation width did not settle after the viewport changed')
  })
}

/** The column scroller and the composer seat as the browser lays them out, in one tab. */
interface TabMetrics {
  /** Resolved `scrollbar-gutter` on the column's scroller. */
  gutter: string
  /** Resolved `overflow-x`: `hidden` in both states, so neither grows a horizontal bar. */
  overflowX: string
  /** Resolved `overflow-y`: `auto` in both states, which is the form WebKit honours the gutter on. */
  overflowY: string
  /** Border-box width minus client width: the space the scrollbar takes out of the content area. */
  band: number
  /** True when the column's scroller actually scrolls — only Chat does. */
  scrolls: boolean
  /** Resolved `display` of the composer seat: hidden leaves the layout on non-Chat views. */
  seatDisplay: string
  /** True when the input card paints with a non-zero box. */
  cardVisible: boolean
  /** Border-box width of the input card; 0 when the seat is hidden. */
  cardWidth: number
}

/** One tab's metrics beside the other's, plus the residency facts of the round trip. */
interface TabComparison {
  chat: TabMetrics
  trajectory: TabMetrics
  /** The seat node present before the round trip is the node present after it. */
  seatSurvived: boolean
  /** The textarea node present before the round trip is the node present after it. */
  textareaSurvived: boolean
}

/**
 * Measure the column scroller and the composer seat in the tab currently shown.
 * @param page - the page under test.
 * @returns the scroller's resolved overflow styles and the seat's visibility.
 */
function measureTab(page: Page): Promise<TabMetrics> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (host === null) throw new Error('conversation column scroller not in the DOM')
    const seat = host.querySelector<HTMLElement>('[data-composer-seat]')
    if (seat === null) throw new Error('composer seat not in the DOM')
    const card = seat.querySelector<HTMLElement>('[data-composer-card]')
    const style = getComputedStyle(host)
    const seatStyle = getComputedStyle(seat)
    const cardRect = card?.getBoundingClientRect()
    return {
      gutter: style.scrollbarGutter,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      band: host.getBoundingClientRect().width - host.clientWidth,
      scrolls: host.scrollHeight > host.clientHeight,
      seatDisplay: seatStyle.display,
      cardVisible: seatStyle.display !== 'none' && cardRect !== undefined
        && cardRect.width > 0 && cardRect.height > 0,
      cardWidth: cardRect?.width ?? 0,
    }
  })
}

/**
 * Show one tab and wait for the view that owns it to be laid out.
 * @param page - the page under test.
 * @param tab - the tab to show.
 */
async function showTab(page: Page, tab: 'Chat' | 'Trajectory'): Promise<void> {
  await page.getByRole('tab', { name: tab, exact: true }).click()
  if (tab === 'Trajectory') await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
  else await page.locator('[data-conversation-scroll] [data-chat-anchor-key]').first().waitFor({ timeout: 30_000 })
  // Both measurements are taken after a paint, so a rectangle read mid-transition
  // cannot be reported as a state the tab did not reach.
  await page.evaluate(() => new Promise<void>((settle) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { settle() }) })
  }))
}

/**
 * Mark the resident seat and textarea, run the Chat → Trajectory → Chat round
 * trip, and measure each stop.
 * @param page - the page under test.
 * @returns each tab's metrics plus whether the marked nodes survived.
 */
async function compareTabs(page: Page): Promise<TabComparison> {
  await showTab(page, 'Chat')
  const marked = await page.evaluate(() => {
    const seat = document.querySelector<HTMLElement>('[data-conversation-scroll] [data-composer-seat]')
    const textarea = seat?.querySelector('textarea')
    if (!(seat instanceof HTMLElement) || !(textarea instanceof Element)) return false
    seat.setAttribute('data-e2e-resident-mark', '')
    textarea.setAttribute('data-e2e-resident-mark', '')
    return true
  })
  if (!marked) throw new Error('composer seat or textarea not found before the round trip')
  const chat = await measureTab(page)
  await showTab(page, 'Trajectory')
  const trajectory = await measureTab(page)
  await showTab(page, 'Chat')
  const survived = await page.evaluate(() => {
    const seat = document.querySelector<HTMLElement>('[data-conversation-scroll] [data-composer-seat]')
    const textarea = seat?.querySelector('textarea') ?? null
    return seat?.hasAttribute('data-e2e-resident-mark') === true
      && textarea?.hasAttribute('data-e2e-resident-mark') === true
  })
  await page.evaluate(() => {
    document.querySelectorAll('[data-e2e-resident-mark]').forEach((node) => {
      node.removeAttribute('data-e2e-resident-mark')
    })
  })
  return { chat, trajectory, seatSurvived: survived, textareaSurvived: survived }
}

/**
 * Open the seeded session from the sidebar search.
 *
 * Cold summaries carry the temp workspace's basename, so the persisted first
 * message is the stable identity to search for, and the query itself drives the
 * lazy content-index reconciliation. Hand-rolled polling because `expect.poll`
 * is test-scoped and this runs in `beforeAll`.
 * @param page - the page under test.
 */
async function openSeededSession(page: Page): Promise<void> {
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
  await search.fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  const deadline = Date.now() + 60_000
  for (;;) {
    if (await results.count() === 1) break
    if (Date.now() > deadline) throw new Error('seeded session never appeared in the sidebar search results')
    await page.waitForTimeout(200)
  }
  await results.click()
}

/**
 * Render the golden body.
 * @param wide - comparison at the viewport where the card sits at its width cap.
 * @param narrow - Chat-only measurement at the viewport where the card shrinks.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(wide: TabComparison, narrow: TabMetrics): string {
  const section = (name: string, comparison: TabComparison): string[] => [
    `## ${name}`,
    '',
    `- Chat: scrollbar-gutter ${comparison.chat.gutter}, overflow ${comparison.chat.overflowX}/${comparison.chat.overflowY}`,
    `- Chat scroller scrolls: ${String(comparison.chat.scrolls)}`,
    `- Chat reserved band: ${String(comparison.chat.band)}px`,
    `- Chat composer seat display: ${comparison.chat.seatDisplay}`,
    `- Chat input card visible: ${String(comparison.chat.cardVisible)}`,
    `- Trajectory: scrollbar-gutter ${comparison.trajectory.gutter}, overflow ${comparison.trajectory.overflowX}/${comparison.trajectory.overflowY}`,
    `- Trajectory scroller scrolls: ${String(comparison.trajectory.scrolls)}`,
    `- Trajectory reserved band: ${String(comparison.trajectory.band)}px`,
    `- Trajectory composer seat display: ${comparison.trajectory.seatDisplay}`,
    `- Trajectory input card visible: ${String(comparison.trajectory.cardVisible)}`,
    `- seat node survived the tab round trip: ${String(comparison.seatSurvived)}`,
    `- textarea node survived the tab round trip: ${String(comparison.textareaSurvived)}`,
    '',
  ]
  return [
    '# Composer seat visibility across the Chat and Trajectory tabs',
    '',
    ...section(`Wide viewport (${String(WIDE_VIEWPORT.width)}px, card at its cap)`, wide),
    `## Narrow viewport (${String(NARROW_VIEWPORT.width)}px, card shrinking with the column)`,
    '',
    `- Chat composer seat display: ${narrow.seatDisplay}`,
    `- Chat input card visible: ${String(narrow.cardVisible)}`,
    `- Chat card narrower than at the cap: ${String(narrow.cardWidth < wide.chat.cardWidth)}`,
    '',
  ].join('\n').trimEnd()
}

describe('web e2e: composer seat visibility across view tabs', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SEED_ID)
    // Scrollbars must take layout space here or the band measurements prove
    // nothing; see the file header for why this argument is dropped.
    browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
    page = await newEnglishPage(browser, WIDE_VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSeededSession(page)
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
    await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last()
      .waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reserves the gutter in Chat and lets the Trajectory view own its scrolling', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-band'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    // Vacuity guard. The scenario must be able to fail: on an engine that
    // does not implement `scrollbar-gutter`, Chat reserves nothing and the
    // reserved-band fact below would read 0. `stable` reserves even without
    // overflow, so a short transcript is not a vacuous case; the poll still
    // pins the measurement to the overflowing state the product ships.
    await expect.poll(async () => (await measureTab(page)).scrolls, { timeout: 10_000 }).toBe(true)
    const comparison = await compareTabs(page)
    expect(comparison.chat.band).toBeGreaterThan(0)
    // Chat keeps the unconditional reservation so its seat's content box never
    // jumps as the transcript starts to scroll.
    expect(comparison.chat.gutter).toBe('stable')
    // The full-bleed branch does NOT reserve: the view owns its own scrollers,
    // so a reserved gutter would only narrow the view's content by the bar's
    // width.
    expect(comparison.trajectory.gutter).toBe('auto')
    expect(comparison.trajectory.band).toBe(0)
    // Declared as a scroll container on both axes rather than left to compute:
    // `overflow: hidden` would drop any reservation in WebKit, and a `visible`
    // horizontal axis computes to `auto` beside a scrolling one.
    expect(comparison.trajectory.overflowY).toBe('auto')
    expect(comparison.trajectory.overflowX).toBe('hidden')
    // Only Chat scrolls this box; the Trajectory view owns its own scrollers.
    expect(comparison.trajectory.scrolls).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('hides the composer outside Chat and keeps the seat resident', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-visibility'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const conversationTextboxes = page.locator('[data-conversation-scroll]').getByRole('textbox')
    await showTab(page, 'Chat')
    // The chat column exposes its textarea to the accessibility tree.
    expect(await conversationTextboxes.count()).toBe(1)
    const comparison = await compareTabs(page)
    // Outside Chat the seat leaves the layout entirely and the hidden subtree
    // is not exposed — no input surface on the Trajectory tab.
    expect(comparison.trajectory.seatDisplay).toBe('none')
    expect(comparison.trajectory.cardVisible).toBe(false)
    // The resident design survives the switch: the same seat and textarea
    // nodes return, so drafts and focus are not rebuilt.
    expect(comparison.seatSurvived).toBe(true)
    expect(comparison.textareaSurvived).toBe(true)
    expect(comparison.chat.seatDisplay).not.toBe('none')
    expect(comparison.chat.cardVisible).toBe(true)
    expect(await conversationTextboxes.count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the Chat card responsive at a narrower column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-narrow'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const capped = await measureTab(page)
    await setMeasuredViewport(page, NARROW_VIEWPORT, true)
    const narrow = await measureTab(page)
    // Below the cap the card takes the column's width; asserted against the
    // capped measurement rather than against the cap's pixel value, which
    // belongs to the stylesheet.
    expect(narrow.cardVisible).toBe(true)
    expect(narrow.cardWidth).toBeLessThan(capped.cardWidth)
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the committed tab visibility golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-tab-geometry-golden'))
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    const wide = await compareTabs(page)
    await setMeasuredViewport(page, NARROW_VIEWPORT, true)
    const narrow = await measureTab(page)
    await setMeasuredViewport(page, WIDE_VIEWPORT, false)
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(wide, narrow), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits exactly the fixtures it reads', async () => {
    // The seeded session is generated in-process, so the geometry golden is the
    // whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
