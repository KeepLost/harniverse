import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  crashReportFileName, CRASH_REPORT_PREFIX, CRASH_REPORTS_RETAINED, ERROR_SECTION_MAX_CHARS,
  pruneCrashReports, renderCrashReport, RendererConsoleTail, writeCrashReport, type CrashReportInput,
} from '../src/crash-report.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-crash-report-'))
  directories.push(path)
  return path
}

function input(overrides: Partial<CrashReportInput> = {}): CrashReportInput {
  return {
    source: 'host',
    phase: 'running',
    error: Object.assign(new Error('boom'), { code: 'ENOENT', path: '/tmp/absent' }),
    rendererConsole: [],
    app: {
      name: 'dsh-harniverse', version: '1.0.0', platform: 'linux', arch: 'x64',
      electron: '40.0.0', node: '24.0.0', locale: 'en-US',
    },
    time: new Date('2026-10-04T00:00:00.000Z'),
    ...overrides,
  }
}

describe('crash report files', () => {
  it('names reports sortable by time then source', () => {
    const time = new Date('2026-10-04T01:02:03.004Z')
    expect(crashReportFileName(time, 'host')).toBe(`${CRASH_REPORT_PREFIX}2026-10-04T01-02-03-004Z-host.log`)
    expect(crashReportFileName(time, 'renderer') > crashReportFileName(time, 'host')).toBe(true)
  })

  it('renders facts, the inspected error, and the renderer console tail', () => {
    const rendered = renderCrashReport(input({ rendererConsole: ['page.js:1 first', 'page.js:2 second'] }))
    expect(rendered).toContain('source: host')
    expect(rendered).toContain('phase: running')
    expect(rendered).toContain('app: dsh-harniverse 1.0.0')
    expect(rendered).toContain('platform: linux x64')
    expect(rendered).toContain('shell pid: ')
    expect(rendered).toContain("'ENOENT'")
    expect(rendered).toContain('/tmp/absent')
    expect(rendered).toContain('page.js:1 first')
  })

  it('states the absence of captured console output', () => {
    expect(renderCrashReport(input())).toContain('(no error-level renderer console output was captured)')
  })

  it('cuts the error section at its bound instead of rendering unbounded diagnostics', () => {
    const error = Object.assign(new Error('wide'), { rows: Array.from({ length: 6 }, () => 'x'.repeat(80_000)) })
    const rendered = renderCrashReport(input({ error }))
    expect(rendered).toContain(`error section cut at ${String(ERROR_SECTION_MAX_CHARS)} characters`)
    expect(rendered.length).toBeLessThan(ERROR_SECTION_MAX_CHARS + 2_000)
  })

  it('writes one owner-readable report file and refuses to overwrite an existing name', async () => {
    const path = directory()
    const written = await writeCrashReport(path, input())
    expect(written).toBeDefined()
    expect(readdirSync(path)).toHaveLength(1)
    expect(readFileSync(written!, 'utf8')).toContain('source: host')
    expect(statSync(written!).mode & 0o777).toBe(0o600)
    // The `wx` flag keeps a repeated write from clobbering the first report.
    expect(await writeCrashReport(path, input())).toBeUndefined()
  })

  it('creates the directory and reports write failures as undefined', async () => {
    const nested = join(directory(), 'logs', 'deep')
    expect(await writeCrashReport(nested, input())).toBeDefined()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = join(directory(), 'occupied')
    await writeFile(file, 'x')
    expect(await writeCrashReport(file, input())).toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
  })

  it('prunes only matching reports beyond the retention bound, oldest first', async () => {
    const path = directory()
    await writeFile(join(path, 'unrelated.log'), 'keep')
    for (let index = 0; index < CRASH_REPORTS_RETAINED + 2; index += 1) {
      const time = new Date(Date.UTC(2026, 9, 1, 0, 0, index))
      await writeFile(join(path, crashReportFileName(time, 'host')), 'x')
    }
    await pruneCrashReports(path)
    const remaining = readdirSync(path)
    expect(remaining).toContain('unrelated.log')
    expect(remaining).toHaveLength(CRASH_REPORTS_RETAINED + 1)
    expect(remaining).not.toContain(crashReportFileName(new Date(Date.UTC(2026, 9, 1, 0, 0, 0)), 'host'))
  })

  it('treats a missing directory as nothing to prune and reports listing failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pruneCrashReports(join(directory(), 'absent'))
    expect(consoleError).not.toHaveBeenCalled()
    const file = join(directory(), 'occupied')
    await writeFile(file, 'x')
    await pruneCrashReports(file)
    expect(consoleError).toHaveBeenCalled()
  })

  it('reports a stale report that cannot be removed', async () => {
    const path = directory()
    const name = crashReportFileName(new Date(Date.UTC(2026, 9, 1)), 'main')
    // A directory with a report's name cannot be unlinked like a file.
    mkdirSync(join(path, name))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pruneCrashReports(path, 0)
    expect(consoleError).toHaveBeenCalled()
  })
})

describe('RendererConsoleTail', () => {
  it('keeps a bounded tail, dropping whole oldest lines but never splitting one', () => {
    const tail = new RendererConsoleTail(10)
    tail.push('12345')
    tail.push('67890')
    expect(tail.snapshot()).toEqual(['12345', '67890'])
    tail.push('abcdefghij')
    expect(tail.snapshot()).toEqual(['abcdefghij'])
    // One oversized line is kept whole rather than cut mid-line.
    tail.push('x'.repeat(40))
    expect(tail.snapshot()).toEqual(['x'.repeat(40)])
  })

  it('snapshots a copy the retained lines do not alias', () => {
    const tail = new RendererConsoleTail()
    tail.push('one')
    const snapshot = tail.snapshot()
    tail.push('two')
    expect(snapshot).toEqual(['one'])
  })
})
