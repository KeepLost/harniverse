/** Release preparation mode preserves the caller's Git history and index. */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const bumpScript = resolve(repositoryRoot, 'scripts/release/bump.ts')
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const manifestPaths = [
  'package.json',
  'packages/core/library/package.json',
  'apps/cli/package.json',
  'pnpm-lock.yaml',
] as const
const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function createFixture(stageUserWork = true): string {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-release-bump-'))
  roots.push(root)
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const version = '0.1.0-rc.5'
  write(join(root, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    version,
    private: true,
  }, null, 2)}\n`)
  write(join(root, 'packages/core/library/package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-library',
    version,
  }, null, 2)}\n`)
  write(join(root, 'apps/cli/package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
  }, null, 2)}\n`)
  write(join(root, 'pnpm-lock.yaml'), 'lockfile initial\n')

  execFileSync('git', ['init', '--quiet'], { cwd: root, env: gitEnv })
  execFileSync('git', ['add', ...manifestPaths], { cwd: root, env: gitEnv })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: root, env: gitEnv })

  write(join(root, 'user-work.txt'), 'user work\n')
  if (stageUserWork) execFileSync('git', ['add', 'user-work.txt'], { cwd: root })
  writeFileSync(join(root, 'pnpm.calls'), '')

  const fakeBin = join(root, '.fake-bin')
  mkdirSync(fakeBin)
  const fakePnpm = join(fakeBin, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  copyFileSync(process.execPath, fakePnpm)
  if (process.platform !== 'win32') chmodSync(fakePnpm, 0o755)
  writeFileSync(join(fakeBin, 'fake-pnpm-preload.cjs'), `
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

if (process.argv.some(argument => argument.endsWith('install'))
  && process.argv.includes('--lockfile-only')) {
  const root = process.env.HARNIVERSE_FAKE_PNPM_ROOT
  if (root === undefined) throw new Error('fake pnpm root is missing')
  const installIndex = process.argv.findIndex(argument => argument.endsWith('install'))
  appendFileSync(join(root, 'pnpm.calls'), JSON.stringify([
    'install',
    ...process.argv.slice(installIndex + 1),
  ]) + String.fromCharCode(10))
  if (process.env.HARNIVERSE_FAKE_PNPM_FAIL === '1') {
    writeFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'lockfile partially updated' + String.fromCharCode(10))
    process.stderr.write('fake lock sync failed\\n')
    process.exit(23)
  } else {
    writeFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'lockfile updated' + String.fromCharCode(10))
    process.exit(0)
  }
}
`)
  return root
}

function runBump(root: string, args: readonly string[], failLockSync = false) {
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const preload = join(root, '.fake-bin', 'fake-pnpm-preload.cjs')
    .replaceAll('\\', '/')
    .replaceAll('"', '\\"')
  return spawnSync(process.execPath, ['--import', tsxLoader, bumpScript, '--family', 'dsh', ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
      GIT_AUTHOR_NAME: 'Release Test',
      GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
      GIT_COMMITTER_NAME: 'Release Test',
      GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      HARNIVERSE_FAKE_PNPM_FAIL: failLockSync ? '1' : '0',
      HARNIVERSE_FAKE_PNPM_ROOT: root,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require "${preload}"`]
        .filter(value => value !== undefined && value !== '')
        .join(' '),
      PATH: `${join(root, '.fake-bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function files(root: string): Record<string, string> {
  return Object.fromEntries(manifestPaths.map(path => [path, readFileSync(join(root, path), 'utf8')]))
}

function index(root: string): string {
  return readFileSync(join(root, '.git/index')).toString('base64')
}

describe('release bump preparation', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('writes the family and lockfile without changing HEAD or the index in no-commit mode', () => {
    const root = createFixture()
    const before = { files: files(root), head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--no-commit', '1.0.0-rc.1'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('prepared; no files staged or commit created')
    expect(files(root)['package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['packages/core/library/package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['apps/cli/package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['pnpm-lock.yaml']).toBe('lockfile updated\n')
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('["install","--lockfile-only"]\n')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('user-work.txt')
    expect(files(root)).not.toEqual(before.files)
  })

  it('keeps every file unchanged in dry-run mode', () => {
    const root = createFixture()
    const before = { files: files(root), head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--dry-run', '1.0.0-rc.1'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry run, nothing written')
    expect(files(root)).toEqual(before.files)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('')
  })

  it('rejects a malformed requested version before writing anything', () => {
    const root = createFixture()
    const before = { files: files(root), head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--no-commit', '01.0.0'])

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/usage: release:dsh .*01\.0\.0/)
    expect(files(root)).toEqual(before.files)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('')
  })

  it('rejects unsupported build metadata before writing anything', () => {
    const root = createFixture()
    const before = { files: files(root), head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--no-commit', '1.0.0-rc.1+build-1'])

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/usage: release:dsh .*1\.0\.0-rc\.1\+build-1/)
    expect(files(root)).toEqual(before.files)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('')
  })

  it('surfaces lockfile sync failure after writes without creating a commit or rolling back work', () => {
    const root = createFixture()
    const before = { head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--no-commit', '1.0.0-rc.1'], true)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/pnpm install --lockfile-only exited with 23/)
    expect(result.stderr).toContain([
      'manifest files written: package.json',
      join('apps', 'cli', 'package.json'),
      join('packages', 'core', 'library', 'package.json'),
    ].join(', '))
    expect(result.stderr).toContain('lockfile sync was attempted; changes are retained for inspection')
    expect(files(root)['package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['packages/core/library/package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['apps/cli/package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['pnpm-lock.yaml']).toBe('lockfile partially updated\n')
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('["install","--lockfile-only"]\n')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('user-work.txt')
  })

  it('reports completed manifest writes when a later manifest cannot be prepared', () => {
    const root = createFixture()
    writeFileSync(join(root, 'packages/core/library/package.json'), '{"name":"@deepseek-ai/dsh-library","version":"0.1.0-rc.5"}\n')
    const before = { head: git(root, 'rev-parse', 'HEAD'), index: index(root) }

    const result = runBump(root, ['--no-commit', '1.0.0-rc.1'])

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${join('packages', 'core', 'library', 'package.json')}: cannot locate`,
    )
    expect(result.stderr).toContain(`manifest files written: package.json, ${join('apps', 'cli', 'package.json')}`)
    expect(result.stderr).toContain('lockfile sync was not attempted; changes are retained for inspection')
    expect(files(root)['package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['apps/cli/package.json']).toContain('"version": "1.0.0-rc.1"')
    expect(files(root)['packages/core/library/package.json']).toBe('{"name":"@deepseek-ai/dsh-library","version":"0.1.0-rc.5"}\n')
    expect(files(root)['pnpm-lock.yaml']).toBe('lockfile initial\n')
    expect(readFileSync(join(root, 'pnpm.calls'), 'utf8')).toBe('')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(index(root)).toBe(before.index)
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('user-work.txt')
  })

  it('keeps regular mode committing the prepared release after lockfile sync', () => {
    const root = createFixture(false)
    const before = git(root, 'rev-parse', 'HEAD')

    const result = runBump(root, ['1.0.0-rc.1'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('release bump: committed')
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(before)
    expect(git(root, 'show', '--format=', '--name-only', 'HEAD')).toEqual([
      'apps/cli/package.json',
      'package.json',
      'packages/core/library/package.json',
      'pnpm-lock.yaml',
    ].join('\n'))
    expect(git(root, 'status', '--short')).toBe('?? .fake-bin/\n?? pnpm.calls\n?? user-work.txt')
  })
})
