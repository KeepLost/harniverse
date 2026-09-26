// Web e2e scenario: the real host serves every discovered skill to the
// browser slash source uniformly. A real chromium connects a fresh workspace
// seeded with plain skills; no model call is issued, so a stray stream fails
// loud on the open LLM seam.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skill-menu', import.meta.url))
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const MODE = webSnapshotMode()

interface SeedSkill {
  name: string
  description: string
  frontmatter: string
}

const SKILLS: readonly SeedSkill[] = [
  {
    name: 'menu-alpha',
    description: 'First uniform catalog entry',
    frontmatter: '',
  },
  {
    name: 'menu-beta',
    description: 'Second uniform catalog entry',
    frontmatter: '',
  },
  {
    name: 'menu-gamma',
    description: 'Third uniform catalog entry',
    frontmatter: '',
  },
]

async function seedSkills(workspaceCwd: string): Promise<void> {
  for (const skill of SKILLS) {
    const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', skill.name)
    await mkdir(directory, { recursive: true })
    const policyLines = skill.frontmatter === '' ? [] : skill.frontmatter.trimEnd().split('\n')
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      ...policyLines,
      '---',
      '',
      `# ${skill.name}`,
      '',
    ].join('\n'))
  }
}

describe('web e2e: the skill menu through the real host', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSkills(scaffold.workspaceCwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders every discovered skill uniformly', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-menu'))
    const input = page.locator('textarea').first()
    await input.fill('/menu-')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await expect.poll(
      () => menu.getByRole('option', { name: /menu-alpha/ }).count(),
      { timeout: 10_000 },
    ).toBe(1)

    expect(await menu.getByRole('option', { name: /menu-beta/ }).count()).toBe(1)
    expect(await menu.getByRole('option', { name: /menu-gamma/ }).count()).toBe(1)
    // The command roster loads asynchronously; the golden pins the settled
    // menu, so wait out its loading group before capture.
    await expect.poll(
      () => menu.getByText('Loading', { exact: false }).count(),
      { timeout: 15_000 },
    ).toBe(0)

    const snapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu.expected.md'])
  })
})
