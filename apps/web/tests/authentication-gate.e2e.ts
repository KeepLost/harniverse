/** Authenticated Web composition blocks plugin loading until browser login. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: authentication gate', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let pluginRequests: string[]
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ authentication: 'token' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    pluginRequests = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/plugins/')) pluginRequests.push(request.url())
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads no plugin bundle before login and releases the app after token exchange', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-authentication-gate'))
    const input = page.getByLabel('访问令牌')
    await input.waitFor({ timeout: 30_000 })
    expect(pluginRequests).toEqual([])
    if (scaffold.authenticationToken === undefined) throw new Error('authenticated scaffold did not return its token')

    await input.fill(scaffold.authenticationToken)
    const loginResponsePromise = page.waitForResponse((response) => {
      return new URL(response.url()).pathname === '/auth/login'
    })
    await page.getByRole('button', { name: '进入工作台' }).click()
    const loginResponse = await loginResponsePromise
    expect({
      method: loginResponse.request().method(),
      status: loginResponse.status(),
      url: loginResponse.url(),
    }).toEqual({ method: 'POST', status: 200, url: `${scaffold.baseUrl}/auth/login` })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(pluginRequests.length).toBeGreaterThan(0)
    expect(await input.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })
})
