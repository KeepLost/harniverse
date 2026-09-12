/** Authenticated Web composition blocks plugin loading until device approval. */
import type { Browser, BrowserContext, Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

describe('web e2e: authentication gate', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let pluginRequests: string[]
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      authentication: 'grant',
      replayFixture: fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url)),
      paceMs: 50,
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page = await context.newPage()
    pluginRequests = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/plugins/')) pluginRequests.push(request.url())
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await scaffold?.close()
  })

  it('loads no plugin bundle before approval and releases the app after signed challenge exchange', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-authentication-gate'))
    const input = page.getByLabel('设备名称')
    await input.waitFor({ timeout: 30_000 })
    // The authentication document renders before any plugin bundle, so its
    // sheet AND the theme tokens must arrive with the entry rather than the
    // post-authentication chunk — otherwise this page ships unstyled.
    const chrome = await page.evaluate(() => {
      const card = document.querySelector('.dsh-auth-card')
      const styles = window.getComputedStyle(card as Element)
      return {
        radius: styles.borderTopLeftRadius,
        bodyBackground: window.getComputedStyle(document.body).backgroundColor,
        primaryFill: window.getComputedStyle(document.querySelector('.dsh-auth-primary') as Element).backgroundColor,
      }
    })
    expect(chrome.radius).toBe('20px')
    expect(chrome.bodyBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(chrome.primaryFill).not.toBe('rgba(0, 0, 0, 0)')
    expect(pluginRequests).toEqual([])
    const sealedBundle = await page.request.get(`${scaffold.baseUrl}/plugins/@deepseek-ai/dsh-client-connection/client.js`)
    const sealedTopology = await page.request.get(`${scaffold.baseUrl}/plugins/events`)
    expect({ bundle: sealedBundle.status(), topology: sealedTopology.status() }).toEqual({ bundle: 401, topology: 401 })
    await input.fill('我的设备')
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
    expect(requests[0]?.name).toBe('我的设备')
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

  it('restores refused sends without reloading, then shows a read-only refresh instruction on revocation', async () => {
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('textarea').first()
    const healthy = page.getByRole('img', { name: 'Connected; authentication is valid', exact: true })
    await healthy.waitFor()
    const sibling = await page.context().newPage()
    await sibling.goto(scaffold.baseUrl)
    await sibling.getByRole('img', { name: 'Connected; authentication is valid', exact: true }).waitFor()
    const statuses: number[] = []
    let exchanges = 0
    let navigations = 0
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1 })
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (path === '/api/session.prompt') statuses.push(response.status())
      if (path === '/auth/exchange') exchanges += 1
    })
    const prompt = 'Use the bash tool to run exactly: echo WEB_E2E_OK. Then reply with the single word DONE and stop.'
    const settled = scaffold.whenTurnSettled(60_000)
    await page.context().clearCookies()
    await input.fill(prompt)
    await input.press('Enter')
    const id = await settled
    expect(statuses).toEqual([401, 200])
    expect(exchanges).toBe(1)
    expect(navigations).toBe(0)
    const events = scaffold.ctx.sessions.get(id)!.events
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    await healthy.waitFor()
    await healthy.hover()
    await page.getByRole('tooltip', { name: 'Connected; authentication is valid', exact: true }).waitFor()
    expect(await healthy.evaluate(element => element.tagName)).toBe('SPAN')
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await healthy.waitFor()
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await input.fill('Keep this unsent draft through authentication loss.')
    const [grant] = await scaffold.ctx.authentication.listGrants()
    await scaffold.ctx.authentication.revokeGrant(grant!.id)
    const required = page.getByRole('img', { name: /Authentication cannot be restored/ })
    await required.waitFor({ timeout: 15_000 })
    await sibling.getByRole('img', { name: /Authentication cannot be restored/ }).waitFor({ timeout: 15_000 })
    await required.hover()
    await page.getByRole('tooltip', { name: /Refresh the page/ }).waitFor()
    expect(await input.inputValue()).toBe('Keep this unsent draft through authentication loss.')
    expect(navigations).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    await sibling.close()
  }, 120_000)
})
