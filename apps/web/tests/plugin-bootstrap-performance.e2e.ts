import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'

describe('web e2e: plugin bootstrap performance', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage()
    tripwire = watchConsole(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reaches the application within five seconds through one plugin script request', async () => {
    const pluginScripts: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/plugins/') && path.endsWith('.js')) pluginScripts.push(path)
    })

    const startedAt = performance.now()
    await page.goto(scaffold.baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[class*="frame"]', { timeout: 5_000 })
    const navigationToFrameMs = performance.now() - startedAt

    expect(navigationToFrameMs).toBeLessThan(5_000)
    expect(pluginScripts).toEqual(['/plugins/bootstrap.js'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 15_000)
})
