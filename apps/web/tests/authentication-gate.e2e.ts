/** Authenticated Web composition blocks plugin loading until device approval. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: authentication gate', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let pluginRequests: string[]
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ authentication: 'grant' })
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

  it('loads no plugin bundle before approval and releases the app after signed challenge exchange', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-authentication-gate'))
    const input = page.getByLabel('设备名称')
    await input.waitFor({ timeout: 30_000 })
    expect(pluginRequests).toEqual([])
    const sealedBundle = await page.request.get(`${scaffold.baseUrl}/plugins/@deepseek-ai/dsh-client-connection/client.js`)
    const sealedTopology = await page.request.get(`${scaffold.baseUrl}/plugins/events`)
    expect({ bundle: sealedBundle.status(), topology: sealedTopology.status() }).toEqual({ bundle: 401, topology: 401 })
    await input.fill('browser-e2e')
    const enrollmentResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/enrollment' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '配对个人设备' }).click()
    const enrollmentResponse = await enrollmentResponsePromise
    expect({
      method: enrollmentResponse.request().method(),
      status: enrollmentResponse.status(),
      url: enrollmentResponse.url(),
    }).toEqual({ method: 'POST', status: 202, url: `${scaffold.baseUrl}/auth/enrollment` })
    expect(pluginRequests).toEqual([])

    const requests = await listEnrollmentRequests({ dshHome: scaffold.harnessHome })
    expect(requests).toHaveLength(1)
    const exchangeResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/exchange')
    await approveEnrollmentRequest(requests[0]!.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome: scaffold.harnessHome })
    const exchangeResponse = await exchangeResponsePromise
    expect(exchangeResponse.status()).toBe(200)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(pluginRequests.length).toBeGreaterThan(0)
    expect(await input.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })
})
