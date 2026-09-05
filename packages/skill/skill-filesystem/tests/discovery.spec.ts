import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { discoverFileSystemSkills } from '../src/index.ts'

/** The standalone one-shot discovery export: same roots and precedence as the provider, no registration. */

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir) })

function rmSync(dir: string): void {
  void rm(dir, { recursive: true, force: true })
}

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name))
  dirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the skill.\n`)
}

describe('discoverFileSystemSkills', () => {
  it('discovers project and user roots in provider precedence order', async () => {
    const home = await tempDir('skill-home-')
    const project = await tempDir('skill-project-')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'same', 'project dsh skill')
    await writeSkill(join(project, '.agents/skills'), 'project-agents-only', 'project agents skill')
    await writeSkill(join(home, '.dsh/skills'), 'same', 'user dsh skill')
    await writeSkill(join(home, '.dsh/skills/.system'), 'hidden-system', 'hidden system skill')

    const candidates = await discoverFileSystemSkills(new Context(), join(project, 'src'), {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
    })

    expect(candidates.map(candidate => candidate.name)).toEqual(['same', 'project-agents-only', 'same'])
    expect(candidates[0]).toMatchObject({
      description: 'project dsh skill',
      source: 'project-dsh',
      provider: 'filesystem',
    })
    expect(candidates[2]).toMatchObject({ description: 'user dsh skill', source: 'user-dsh' })
    expect(candidates.some(candidate => candidate.name === 'hidden-system')).toBe(false)
  })

  it('honors customSkillDirs and providerName without touching project or user roots', async () => {
    const project = await tempDir('skill-project-')
    const custom = await tempDir('skill-custom-')
    await writeSkill(join(project, '.dsh/skills'), 'project-only', 'project skill')
    await writeSkill(custom, 'custom-only', 'custom skill')

    const candidates = await discoverFileSystemSkills(new Context(), join(project, 'src'), {
      includeDefaultRoots: false,
      customSkillDirs: [custom],
      providerName: 'one-shot',
    })

    expect(candidates.map(candidate => candidate.name)).toEqual(['custom-only'])
    expect(candidates[0]).toMatchObject({ source: 'custom', provider: 'one-shot' })
  })

  it('returns no candidates without roots or a cwd', async () => {
    const empty = await discoverFileSystemSkills(new Context(), undefined, {
      includeDefaultRoots: false,
      dshHome: join(await tempDir('skill-empty-home-'), '.dsh'),
    })
    expect(empty).toEqual([])
  })
})
