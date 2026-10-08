/**
 * Settings → IM 机器人 through the real assembly: the shipped web composition
 * (real Grant authentication, replayed model) hosts the chat manager and its
 * embedded bridge, and a scripted Telegram Bot API on loopback stands in for
 * Telegram. The scenario drives the browser Settings page end to end: a
 * refused then accepted connect, the card's status, alias and workspace
 * edits, a pairing code redeemed by the fake platform, a conversation whose
 * reply the fake platform receives, unpairing, and removal back to the empty
 * state. Chinese copy is mirrored here as literals (see this directory's README).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import { fixtureUserPrompts, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
/** The only token the fake Bot API accepts; any other well-formed token is refused as Unauthorized. */
const GOOD_TOKEN = `777000:${'A'.repeat(35)}`
const BAD_TOKEN = `777000:${'B'.repeat(35)}`
/** The user the fake platform speaks as. */
const ALICE = { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' }

/** One recorded Bot API request. */
interface BotCall {
  method: string
  payload: Record<string, unknown>
}

/** A scripted Telegram Bot API on loopback: getMe, a long-polled getUpdates, and recorded sends. */
class FakeTelegram {
  readonly calls: BotCall[] = []
  private readonly server: Server
  private readonly queue: Array<{ update_id: number }> = []
  private readonly wakers = new Set<() => void>()
  private nextUpdate = 1000
  private nextMessage = 1

  constructor() {
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  /** Listen on an OS-assigned loopback port. @returns the Bot API origin the connect form takes. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => { this.server.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}/`
  }

  /** Stop listening and release any parked long poll. */
  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }

  /** Deliver one private text message from Alice on the next poll. */
  say(text: string): void {
    const update = {
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++, from: ALICE, chat: { id: ALICE.id, type: 'private', first_name: 'Alice' },
        date: Math.floor(Date.now() / 1000), text,
      },
    }
    this.queue.push(update)
    for (const wake of [...this.wakers]) wake()
  }

  /** Texts of every message the bridge sent or edited, in call order. */
  texts(): string[] {
    return this.calls
      .filter(call => call.method === 'sendMessage' || call.method === 'editMessageText')
      .map(call => typeof call.payload.text === 'string' ? call.payload.text : '')
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const payload = body === '' ? {} : JSON.parse(body) as Record<string, unknown>
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '')
    if (match === null) {
      response.writeHead(404).end()
      return
    }
    const [, token, method] = match as unknown as [string, string, string]
    if (token !== GOOD_TOKEN) {
      response.writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
      return
    }
    this.calls.push({ method, payload })
    if (method === 'getUpdates') {
      await this.poll(payload, response)
      return
    }
    const result = method === 'getMe'
      ? { id: 777000, is_bot: true, first_name: 'E2E Bot', username: 'E2EBot' }
      : method === 'sendMessage'
        ? { message_id: 5000 + this.calls.length, chat: { id: payload.chat_id } }
        : true
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
  }

  /** Answer one long poll: queued updates at or after `offset`, else wait briefly for one. */
  private async poll(payload: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const offset = typeof payload.offset === 'number' ? payload.offset : 0
    const ready = (): Array<{ update_id: number }> => this.queue.filter(update => update.update_id >= offset)
    if (ready().length === 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.wakers.delete(done)
          resolve()
        }
        const timer = setTimeout(done, 1500)
        this.wakers.add(done)
        response.once('close', done)
      })
    }
    if (response.writableEnded || response.destroyed) return
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: ready() }))
  }
}

describe('Settings → IM bots: Telegram bot lifecycle against a scripted Bot API', () => {
  let scaffold: WebScaffold
  let telegram: FakeTelegram
  let apiOrigin: string
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let workspaceDir: string

  /** The settings dialog. */
  const dialog = (): Locator => page.getByRole('dialog', { name: '设置' })
  /** The single bot card (the scenario never connects a second bot); `data-state` marks bot cards apart from other list items. */
  const card = (): Locator => dialog().locator('li[data-state]')

  beforeAll(async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    telegram = new FakeTelegram()
    apiOrigin = await telegram.start()
    scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, paceMs: 5 })
    workspaceDir = join(scaffold.workspaceCwd, 'workspace')
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const deviceName = page.getByLabel('设备名称')
    await deviceName.waitFor({ timeout: 30_000 })
    await deviceName.fill('IM E2E')
    const enrollmentResponse = page.waitForResponse(response => response.url().includes('enroll'))
    await page.getByRole('button', { name: '配对个人设备' }).click()
    await enrollmentResponse.catch(() => {})
    const requests = await listEnrollmentRequests({ dshHome: scaffold.harnessHome })
    expect(requests.length).toBeGreaterThan(0)
    await approveEnrollmentRequest(requests[0]!.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome: scaffold.harnessHome })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Registers the workspace the bot's workspace chooser will offer.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await telegram?.stop()
  })

  it('opens the IM section on its empty state, which explains how to create a Telegram bot', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-empty'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await dialog().waitFor({ timeout: 10_000 })
    await dialog().getByRole('button', { name: 'IM 机器人' }).click()
    await dialog().getByRole('heading', { name: 'IM 机器人', level: 2 }).waitFor({ timeout: 10_000 })
    const channels = dialog().getByRole('navigation', { name: '聊天渠道' })
    await channels.getByRole('button', { name: /^Telegram/ }).waitFor({ timeout: 15_000 })
    await channels.getByRole('button', { name: /^飞书/ }).waitFor({ timeout: 15_000 })
    await dialog().getByText('在 @BotFather 创建一个机器人', { exact: false }).waitFor({ timeout: 10_000 })
    await dialog().getByText('0 / 0 在线').waitFor({ timeout: 10_000 })
  }, 60_000)

  it('refuses a bad token inline, then connects the bot and shows it running', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-connect'))
    await dialog().getByRole('button', { name: '接入机器人' }).click()
    const form = dialog().getByRole('form', { name: '接入 Telegram 机器人' })
    await form.waitFor({ timeout: 10_000 })
    await form.getByLabel('Bot API 地址').fill(apiOrigin)
    await form.getByLabel('机器人 Token', { exact: true }).fill(BAD_TOKEN)
    await form.getByRole('button', { name: '连接', exact: true }).click()
    await form.getByRole('alert').filter({ hasText: '凭据无效，请检查后重试' }).waitFor({ timeout: 20_000 })
    // The token never echoes back into the page as readable text.
    expect(await form.getByLabel('机器人 Token', { exact: true }).getAttribute('type')).toBe('password')

    await form.getByLabel('机器人 Token', { exact: true }).fill(GOOD_TOKEN)
    await form.getByRole('button', { name: '连接', exact: true }).click()
    await form.waitFor({ state: 'detached', timeout: 30_000 })
    await card().getByText('运行正常').waitFor({ timeout: 30_000 })
    await dialog().getByText('1 / 1 在线').waitFor({ timeout: 10_000 })
    expect(await card().textContent()).toContain('E2E Bot')
    expect(telegram.calls.some(call => call.method === 'getMe')).toBe(true)
    expect(telegram.calls.some(call => call.method === 'getUpdates')).toBe(true)
  }, 90_000)

  it('renames the bot inline and keeps the alias across the next poll', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-alias'))
    await card().getByRole('button', { name: '重命名 E2E Bot' }).click()
    const alias = card().getByLabel('机器人别名')
    await alias.fill('值班机器人')
    await alias.press('Enter')
    // The card renders the host's snapshot, so the new alias appearing proves the write and the refetch.
    await card().getByText('值班机器人', { exact: true }).waitFor({ timeout: 15_000 })
    // Escape inside the editor cancels the rename and leaves the settings panel open.
    await card().getByRole('button', { name: '重命名 值班机器人' }).click()
    await card().getByLabel('机器人别名').press('Escape')
    await card().getByRole('button', { name: '重命名 值班机器人' }).waitFor({ timeout: 10_000 })
    expect(await dialog().count()).toBe(1)
  }, 60_000)

  it('chooses a registered workspace and checks the connection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-workspace'))
    // A freshly connected bot's card opens expanded.
    await card().getByRole('button', { name: '收起 值班机器人' }).waitFor({ timeout: 10_000 })
    await card().getByRole('button', { name: '选择目录' }).click()
    const registered = card().getByLabel('已登记的工作区')
    await registered.selectOption({ value: workspaceDir })
    await card().locator('code', { hasText: workspaceDir }).first().waitFor({ timeout: 15_000 })

    await card().getByRole('button', { name: '检查连接' }).click()
    await card().getByText(/^连接正常/).waitFor({ timeout: 20_000 })
  }, 60_000)

  it('pairs an account with a one-time code redeemed from the platform', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-pairing'))
    await dialog().getByText('还没有绑定的账号', { exact: false }).waitFor({ timeout: 10_000 })
    await dialog().getByRole('button', { name: '生成配对码' }).click()
    const codeElement = dialog().getByLabel('配对码', { exact: true })
    await codeElement.waitFor({ timeout: 15_000 })
    const code = (await codeElement.textContent())?.trim() ?? ''
    expect(code).toMatch(/^[0-9A-Z-]{8,}$/)
    await dialog().getByText(/后失效$/).waitFor({ timeout: 10_000 })
    await dialog().getByText(`/pair ${code}`, { exact: true }).waitFor({ timeout: 10_000 })
    await dialog().getByRole('button', { name: '复制配对码' }).waitFor({ timeout: 10_000 })

    telegram.say(`/pair ${code}`)
    await expect.poll(() => telegram.texts().some(text => text.startsWith('Paired')), { timeout: 30_000 }).toBe(true)
    // The next snapshot read lists the paired account.
    await dialog().getByText('用户 ID 42', { exact: false }).waitFor({ timeout: 15_000 })
    await dialog().getByRole('button', { name: /^解除 .* 的绑定$/ }).waitFor({ timeout: 10_000 })
  }, 90_000)

  it('delivers a conversation turn to the platform', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-conversation'))
    const settled = scaffold.whenTurnSettled(60_000)
    telegram.say(PROMPT)
    await settled
    await expect.poll(() => telegram.texts().some(text => text.includes('LIGHTHOUSE')), { timeout: 30_000 }).toBe(true)
  }, 120_000)

  it('unpairs the account, removes the bot after a confirmation, and returns to the empty state', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-im-remove'))
    await dialog().getByRole('button', { name: /^解除 .* 的绑定$/ }).click()
    await dialog().getByText('还没有绑定的账号', { exact: false }).waitFor({ timeout: 15_000 })

    await card().getByRole('button', { name: '移除接入' }).click()
    await card().getByRole('alert').filter({ hasText: '确定移除“值班机器人”？' }).waitFor({ timeout: 10_000 })
    // The confirmation starts on its safe choice and the bot is still there.
    expect(await card().getByRole('button', { name: '取消' }).evaluate(node => node === document.activeElement)).toBe(true)
    await card().getByRole('button', { name: '确认移除' }).click()
    await dialog().getByText('还没有接入 Telegram 机器人', { exact: false }).waitFor({ timeout: 30_000 })
    await dialog().getByText('0 / 0 在线').waitFor({ timeout: 10_000 })
    expect(await card().count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
