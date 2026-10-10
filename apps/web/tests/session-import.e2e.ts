// Web e2e scenario: importing an official DeepSeek Harness session through
// Settings → 会话导入 and continuing it. An official v4 log sits in the shared
// sessions root exactly as an official build leaves it (a multi-frame
// Zstandard `session.v4.jsonl.zstd`); the real composition scans it, imports it
// into the workspace at its own working directory, opens the read-only
// archive with its dock and inert composer, and continues it into a new live
// session seeded from the mapped history. Zero model calls: continuing seeds
// a session without starting a turn, so there is no fixture and a stray
// stream would fail loud on the open llm seam.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the ctx.sessionPersistence and ctx.workspaceRegistry merges the world-state reads use.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { officialArtifact } from '../../../packages/session/session-import/tests/import-fixture.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/session-import', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const DOCK_EXPECTED = join(SNAPSHOT_DIR, 'dock.expected.md')
const MODE = webSnapshotMode()

/** Encode a log as official builds do: the header frame, then one frame per batch. */
function officialZstd(text: string): Buffer {
  const split = text.indexOf('\n') + 1
  return Buffer.concat([zstdCompressSync(Buffer.from(text.slice(0, split))), zstdCompressSync(Buffer.from(text.slice(split)))])
}

describe('web e2e: official session import and continuation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sourceCwd: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The official session ran in a directory that exists on this machine,
    // so the default target registers the workspace there on demand.
    sourceCwd = join(scaffold.workspaceCwd, 'official-project')
    await mkdir(sourceCwd)
    const [header, ...events] = (await officialArtifact(4)).split('\n')
    const text = [JSON.stringify({ ...JSON.parse(header as string) as object, cwd: sourceCwd }), ...events].join('\n')
    const dir = join(scaffold.persistenceRoot, '--official-project--', 'session-official-web-e2e')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), officialZstd(text))
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Open Settings on the session-import section. */
  async function openSection() {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '会话导入', exact: true }).click()
    await dialog.getByRole('heading', { name: '导入官方 DeepSeek Harness 会话', level: 2 }).waitFor({ timeout: 10_000 })
    return dialog
  }

  /** The persisted sessions the Host lists, read through its own persistence. */
  async function headers() {
    return await scaffold.ctx.sessionPersistence.list()
  }

  it('scans the official log and imports it into the workspace at its own working directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-import-section'))
    const dialog = await openSection()
    const row = dialog.getByRole('checkbox', { name: /Use the bash tool to/u })
    await row.waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('未导入', { exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('combobox', { name: '导入到' }).inputValue()).toBe('source-cwd')
    // The scanned root is a run-local temp directory, and each row carries a
    // local calendar date and a codec-dependent size; the title row and status stay.
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, [/\d{4}-\d{2}-\d{2}/u, /dsh-web-e2e-sessions-/u])
    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)

    await row.check()
    await dialog.getByRole('button', { name: '导入所选（1）' }).click()
    await dialog.getByRole('heading', { name: '导入结果' }).waitFor({ timeout: 15_000 })
    // The rescan marks the candidate imported.
    await expect.poll(() => dialog.getByText('已导入', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    // The Host persisted the archive into the newly registered workspace.
    const archives = (await headers()).filter(header => header.id.startsWith('session-imported-'))
    expect(archives.map(header => header.cwd)).toEqual([sourceCwd])
    const [workspace] = scaffold.ctx.workspaceRegistry.list()
    expect(workspace?.path).toBe(sourceCwd)
    expect(workspace?.sessionIds).toEqual([archives[0]?.id])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('opens the read-only archive with its dock and an inert composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-import-archive'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '打开', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 10_000 }).toBe(0)
    const dock = page.getByRole('region', { name: '只读归档' })
    await dock.waitFor({ timeout: 15_000 })
    await page.getByText('TERMINAL_OK').first().waitFor({ timeout: 15_000 })
    const input = page.locator('[data-composer-seat] textarea').first()
    await expect.poll(() => input.isDisabled(), { timeout: 10_000 }).toBe(true)
    expect(await input.getAttribute('placeholder')).toBe('这是只读归档，点上方的“继续对话”接着聊')
    // The dock reads the preset roster over the wire after it shows; a capture taken before the answer lands
    // would record the loading state and make the golden a race against the runner's speed.
    await expect.poll(() => dock.getByRole('option').count(), { timeout: 15_000 }).toBeGreaterThan(1)
    const snapshot = await captureStableAria(page, '[aria-label="只读归档"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DOCK_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('continues the archive into a new live session seeded from its history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-import-continue'))
    const before = new Set((await headers()).map(header => header.id))
    const created = new Promise<Session>((resolve) => {
      const stop = scaffold.ctx.on('session/created', (session: Session) => {
        stop()
        resolve(session)
      })
    })
    await page.getByRole('region', { name: '只读归档' }).getByRole('button', { name: '继续对话' }).click()
    const continuation = await created
    expect(before.has(continuation.id)).toBe(false)
    // The continuation is a fresh, lineage-free session in the same workspace.
    expect(continuation.header.cwd).toBe(sourceCwd)
    expect(continuation.header.parentSession).toBeUndefined()
    const events: readonly SessionEvent[] = continuation.events
    expect(events.some(event => event.type === 'import/record')).toBe(false)
    const messages = JSON.stringify(continuation.deriveMessages())
    expect(messages).toContain('The conversation history below was imported from an official DeepSeek Harness session')
    expect(messages).toContain('TERMINAL_OK')
    expect(messages).not.toContain('This session cannot execute')
    await expect.poll(() => scaffold.ctx.workspaceRegistry.list()[0]?.sessionIds.includes(continuation.id), { timeout: 10_000 }).toBe(true)

    // The browser lands in the continuation: no dock, and the composer accepts input.
    await expect.poll(() => page.getByRole('region', { name: '只读归档' }).count(), { timeout: 15_000 }).toBe(0)
    await page.getByText('TERMINAL_OK').first().waitFor({ timeout: 15_000 })
    const input = page.locator('[data-composer-seat] textarea').first()
    await expect.poll(() => input.isDisabled(), { timeout: 10_000 }).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dock.expected.md', 'section.expected.md'])
  })
})
