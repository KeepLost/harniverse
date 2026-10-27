import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/working-directory-domain/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('working-directory and worktree domains through a real cordis.yml and headless process', () => {
  it('persists directory changes and the entered worktree in the session log', async () => {
    let events: SessionEvent[] = []
    let worktreePath: string | undefined
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'working-directory-domain',
      tempDirPrefix: 'working-directory-e2e-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the working-directory domain'],
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
        const pool = join(cwd, '.agents/worktrees/smoke-worktree')
        if (await stat(pool).then(info => info.isDirectory(), () => false)) worktreePath = pool
      },
    })
    expect(stderr).toBe('')
    const result = JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect(result).toMatchObject({ type: 'result' })

    const changes = events.filter(event => event.type === 'working-directory/change')
    expect(changes.length).toBeGreaterThanOrEqual(3)
    if (changes[0] === undefined) throw new Error('expected a first change event')
    expect(changes.at(-1)?.data.cwd).toBe(worktreePath)
    const notices = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'working-directory')
    expect(notices.length).toBe(changes.length)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
