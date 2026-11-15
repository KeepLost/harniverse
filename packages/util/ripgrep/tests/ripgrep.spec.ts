/** resolveRgPath/spawnRipgrep/readRipgrepLines against the real local subprocess seam. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { readRipgrepLines, resolveRgPath, spawnRipgrep } from '../src/index.ts'

let ctx: Context
let subprocess: LocalSubprocessRuntime

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime).await()
  subprocess = ctx.get('subprocess') as LocalSubprocessRuntime
})

afterAll(async () => {
  await ctx.fiber.dispose()
})

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-util-ripgrep-'))
}

describe('resolveRgPath', () => {
  it('resolves the packaged executable once per process', async () => {
    const path = await resolveRgPath()
    expect(path.length).toBeGreaterThan(0)
    expect(await resolveRgPath()).toBe(path)
  })
})

describe('readRipgrepLines', () => {
  it('streams NUL-separated file paths in order and completes cleanly', async () => {
    const root = tempWorkspace()
    try {
      writeFileSync(join(root, 'a.txt'), '')
      writeFileSync(join(root, 'b.txt'), '')
      const handle = await spawnRipgrep(subprocess, {
        argv: ['--files', '--sort=path', '--null', '--path-separator=/'],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } },
        graceMs: 5000,
        signal: new AbortController().signal,
      })
      const paths: string[] = []
      const { outcome, stopped } = await readRipgrepLines(handle, '\0', (path) => {
        paths.push(path)
        return true
      })
      expect(paths).toEqual(['a.txt', 'b.txt'])
      expect(stopped).toBe(false)
      expect(outcome.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('terminates the process early when the consumer returns false', async () => {
    const root = tempWorkspace()
    try {
      for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), '')
      const handle = await spawnRipgrep(subprocess, {
        argv: ['--files', '--sort=path', '--null', '--path-separator=/'],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } },
        graceMs: 5000,
        signal: new AbortController().signal,
      })
      const seen: string[] = []
      const { stopped } = await readRipgrepLines(handle, '\0', (path) => {
        seen.push(path)
        return false
      })
      expect(seen).toEqual(['a.txt'])
      expect(stopped).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads newline-separated records for text output', async () => {
    const root = tempWorkspace()
    try {
      writeFileSync(join(root, 'only.txt'), '')
      const handle = await spawnRipgrep(subprocess, {
        argv: ['--files', '--sort=path'],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } },
        graceMs: 5000,
        signal: new AbortController().signal,
      })
      const lines: string[] = []
      const { outcome } = await readRipgrepLines(handle, '\n', (line) => {
        lines.push(line)
        return true
      })
      expect(lines).toEqual(['only.txt'])
      expect(outcome.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects when stdout is not piped', async () => {
    const handle = await spawnRipgrep(subprocess, {
      argv: ['--files'],
      cwd: '.',
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 1024 } },
      graceMs: 5000,
      signal: new AbortController().signal,
    })
    await expect(readRipgrepLines(handle, '\n', () => true)).rejects.toThrow('ripgrep requires piped stdout')
  })

  it('propagates a consumer failure after the process settles', async () => {
    const root = tempWorkspace()
    try {
      writeFileSync(join(root, 'a.txt'), '')
      const handle = await spawnRipgrep(subprocess, {
        argv: ['--files', '--sort=path', '--null'],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } },
        graceMs: 5000,
        signal: new AbortController().signal,
      })
      await expect(readRipgrepLines(handle, '\0', () => { throw new Error('consumer failed') }))
        .rejects.toThrow('consumer failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
