/**
 * Workbench preview edit + save through the real assembly: the composed
 * ui-workspace-editor occupant takes over an editable family, a manual save
 * reaches the workspace-file-write Remote, and the committed bytes re-encode
 * faithfully (CRLF restore). The read-only golden composition lives in the
 * sibling workbench suite; this one composes the default bundle with the
 * editor row enabled.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, beforeAll, afterAll, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { approveEnrollmentRequest, listEnrollmentRequests } from '@deepseek-ai/dsh-authentication-local'
import { fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const execFileAsync = promisify(execFile)
const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

let scaffold: Awaited<ReturnType<typeof launchWebScaffold>>
let browser: Browser
let page: Page
let workspaceDir: string

beforeAll(async () => {
  const fixture = await readFile(FIXTURE, 'utf8')
  expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
  scaffold = await launchWebScaffold({ authentication: 'grant', replayFixture: FIXTURE, paceMs: 5 })
  workspaceDir = join(scaffold.workspaceCwd, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  // CRLF on disk: the save must restore the original line-ending style.
  await writeFile(join(workspaceDir, 'notes.md'), '# Notes\r\n\r\nDraft body.\r\n', 'utf8')
  await execFileAsync('git', ['init', '-b', 'main', workspaceDir])
  await execFileAsync('git', ['-C', workspaceDir, 'config', 'user.name', 'Edit E2E'])
  await execFileAsync('git', ['-C', workspaceDir, 'config', 'user.email', 'edit@example.invalid'])
  await execFileAsync('git', ['-C', workspaceDir, 'add', '--', 'notes.md'])
  await execFileAsync('git', ['-C', workspaceDir, 'commit', '-m', 'initial'])

  browser = await chromium.launch()
  page = await newEnglishPage(browser, 900)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  const deviceName = page.getByLabel('设备名称')
  await deviceName.waitFor({ timeout: 30_000 })
  await deviceName.fill('Edit E2E')
  const enrollmentResponse = page.waitForResponse(response => response.url().includes('enroll'))
  await page.getByRole('button', { name: '配对个人设备' }).click()
  await enrollmentResponse.catch(() => {})
  const requests = await listEnrollmentRequests({ dshHome: scaffold.harnessHome })
  expect(requests.length).toBeGreaterThan(0)
  await approveEnrollmentRequest(requests[0]!.id, {
    capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
  }, { dshHome: scaffold.harnessHome })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const settled = scaffold.whenTurnSettled()
  await page.locator('textarea').first().fill(PROMPT)
  await page.locator('textarea').first().press('Enter')
  await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

it('edits an editable family and saves through the workspace-file-write Remote', async () => {
  await page.getByRole('button', { name: 'Open workspace workbench' }).click()
  const workbench = page.getByRole('complementary', { name: 'Workspace workbench' })
  await workbench.waitFor({ timeout: 15_000 })
  await workbench.getByRole('tabpanel').getByRole('button', { name: /notes\.md$/ }).click()

  const editor = page.locator('[data-workspace-editor]')
  await editor.waitFor({ timeout: 15_000 })
  await editor.getByText('No changes').waitFor({ timeout: 15_000 })
  const content = editor.locator('.cm-content')
  await content.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('# Edited notes\n')
  await editor.getByText('Unsaved changes').waitFor({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Save changes to notes.md' }).click()
  await editor.getByText('No changes').waitFor({ timeout: 15_000 })

  // The save restores the file's original CRLF style byte-for-byte.
  const disk = await readFile(join(workspaceDir, 'notes.md'), 'utf8')
  expect(disk).toBe('# Edited notes\r\n')
}, 120_000)
