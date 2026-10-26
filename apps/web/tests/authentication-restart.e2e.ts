/** A restarted authenticated Host readmits every open tab of every paired device. */
import type { Browser, BrowserContext, Page } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const HEALTHY = 'Connected; authentication is valid'
const RECONNECTING = 'Connection interrupted; reconnecting automatically'
// Below every tab's dead-Cookie traffic: an admission path that still counted
// those values would lock out the shared loopback peer for the whole block.
const AUTH_FAILURE_LIMIT = 2
const TABS_PER_DEVICE = 2

interface AccessRecord {
  event?: string
  reasonCode?: string
}

async function accessRecords(harnessHome: string): Promise<AccessRecord[]> {
  const text = await readFile(join(harnessHome, 'auth', 'access.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as AccessRecord)
}

function status(page: Page, name: string): ReturnType<Page['getByRole']> {
  return page.getByRole('img', { name, exact: true })
}

describe('web e2e: authenticated Host restart', () => {
  let harnessHome: string
  let scaffold: WebScaffold | undefined
  let browser: Browser
  const devices: BrowserContext[] = []
  const tabs: Page[] = []

  beforeAll(async () => {
    // Outside both scaffolds' temp worlds, so the Grant registry and the
    // devices' enrolled keys survive the first Host's teardown.
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-restart-home-'))
    scaffold = await launchWebScaffold({ authentication: 'grant', harnessHome, authFailureLimit: AUTH_FAILURE_LIMIT })
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    for (const device of devices) await device.close()
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  async function pairDevice(host: WebScaffold, name: string): Promise<void> {
    const device = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    devices.push(device)
    const page = await device.newPage()
    tabs.push(page)
    await page.goto(host.baseUrl, { waitUntil: 'load' })
    await page.getByLabel('设备名称').fill(name)
    const enrollment = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/auth/enrollment' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '配对个人设备' }).click()
    expect((await enrollment).status()).toBe(202)
    const request = (await listEnrollmentRequests({ dshHome: harnessHome })).find(item => item.name === name)
    if (request === undefined) throw new Error(`no pending enrollment for ${name}`)
    await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome: harnessHome })
    await status(page, HEALTHY).waitFor({ timeout: 60_000 })
    for (let index = 1; index < TABS_PER_DEVICE; index += 1) {
      const tab = await device.newPage()
      tabs.push(tab)
      await tab.goto(host.baseUrl, { waitUntil: 'load' })
      await status(tab, HEALTHY).waitFor({ timeout: 60_000 })
    }
  }

  it('readmits every open tab of every paired device without locking out their shared peer', async () => {
    onTestFailed(async () => { if (tabs[0] !== undefined) await saveFailureShot(tabs[0], 'web-e2e-authentication-restart') })
    const first = scaffold!
    await pairDevice(first, 'laptop')
    await pairDevice(first, 'desktop')
    const baseUrl = first.baseUrl
    const recorded = (await accessRecords(harnessHome)).length

    // The successor process starts with no browser sessions, so every tab
    // still holds a Cookie it has never issued.
    scaffold = undefined
    await first.close()
    for (const tab of tabs) await status(tab, RECONNECTING).waitFor({ timeout: 30_000 })
    scaffold = await launchWebScaffold({
      authentication: 'grant',
      harnessHome,
      authFailureLimit: AUTH_FAILURE_LIMIT,
      port: Number(new URL(baseUrl).port),
    })
    expect(scaffold.baseUrl).toBe(baseUrl)

    for (const tab of tabs) await status(tab, HEALTHY).waitFor({ timeout: 45_000 })
    const afterRestart = (await accessRecords(harnessHome)).slice(recorded)
    expect(afterRestart.filter(record => record.reasonCode === 'invalid-credential').length)
      .toBeGreaterThan(AUTH_FAILURE_LIMIT)
    expect(afterRestart.filter(record => record.reasonCode === 'rate-limited')).toEqual([])
    expect(afterRestart.filter(record => record.event === 'browser-login-accepted').length)
      .toBeGreaterThanOrEqual(devices.length)
  }, 180_000)
})
