import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

interface Loc {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

interface ReporterInstance {
  onStart(): void
  onDetail(node: { getFileCoverage(): FileCoverageShape }): void
  onEnd(): void
}

// istanbul-reports loads custom reporters with a bare CommonJS require outside
// the tsx/ESM pipeline; the spec loads it the same way it is loaded in a run.
const UncoveredLocationsReport = createRequire(import.meta.url)(
  './coverage-uncovered-locations.cjs',
) as new (opts: { projectRoot: string }) => ReporterInstance

/** One istanbul location spanning a single line. */
function loc(line: number, column = 2, endColumn = 20): Loc {
  return { start: { line, column }, end: { line, column: endColumn } }
}

interface FileCoverageShape {
  path: string
  statementMap: Record<string, Loc>
  s: Record<string, number>
  fnMap: Record<string, { name?: string; decl: Loc; loc: Loc }>
  f: Record<string, number>
  branchMap: Record<string, { type: string; loc: Loc; locations?: Loc[] }>
  b: Record<string, number[]>
}

/** Run the reporter over one synthetic file and capture its printed lines. */
function report(fc: FileCoverageShape): string[] {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(value => String(value)).join(' '))
  })
  try {
    const reporter = new UncoveredLocationsReport({ projectRoot: '/repo' })
    reporter.onStart()
    reporter.onDetail({ getFileCoverage: () => fc })
    reporter.onEnd()
  } finally {
    log.mockRestore()
  }
  return lines
}

/** A file whose every entry is covered. */
function covered(): FileCoverageShape {
  return {
    path: '/repo/packages/demo/demo/src/thing.ts',
    statementMap: { 0: loc(10) },
    s: { 0: 3 },
    fnMap: { 0: { name: 'run', decl: loc(20), loc: loc(20) } },
    f: { 0: 1 },
    branchMap: { 0: { type: 'if', loc: loc(30), locations: [loc(30), loc(31)] } },
    b: { 0: [2, 4] },
  }
}

describe('coverage uncovered-locations reporter', () => {
  it('stays silent for a file with every entry covered', () => {
    expect(report(covered())).toEqual([])
  })

  it('reports each uncovered statement, function, and branch path', () => {
    const fc = covered()
    fc.s = { 0: 0 }
    fc.f = { 0: 0 }
    fc.b = { 0: [2, 0] }
    const lines = report(fc).join('\n')
    expect(lines).toContain('Uncovered locations (per-file 100% gate): 3')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:10:3 uncovered statement')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:20:3 uncovered function run')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:31:3 uncovered branch (if, path 2/2)')
    expect(lines).not.toContain('corrupt')
  })

  it('reports a count below zero as a merge defect, never as an uncovered gap', () => {
    const fc = covered()
    fc.b = { 0: [-21, 0] }
    const lines = report(fc).join('\n')
    expect(lines).toContain('Corrupt coverage counts (below zero, merge defect — NOT a coverage gap): 1')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:30:3 corrupt branch count -21 (if, path 1/2)')
    // The zeroed sibling of a corrupted slot still prints, with the caveat
    // that the corrupt section supplies.
    expect(lines).toContain('packages/demo/demo/src/thing.ts:31:3 uncovered branch (if, path 2/2)')
    expect(lines).toContain('Re-read the file with a single suite before trusting any gap above.')
  })

  it('separates corrupt statement and function counts from uncovered ones', () => {
    const fc = covered()
    fc.statementMap = { 0: loc(10), 1: loc(11) }
    fc.s = { 0: -3, 1: 0 }
    fc.f = { 0: -1 }
    const lines = report(fc).join('\n')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:10:3 corrupt statement count -3')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:20:3 corrupt function count -1 run')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:11:3 uncovered statement')
    expect(lines).toContain('Uncovered locations (per-file 100% gate): 1')
  })

  it('falls back to the branch span when an implicit arm carries no location', () => {
    const fc = covered()
    fc.branchMap = { 0: { type: 'if', loc: loc(30) } }
    fc.b = { 0: [1, 0] }
    const lines = report(fc).join('\n')
    expect(lines).toContain('packages/demo/demo/src/thing.ts:30:3 uncovered branch (if, path 2/2)')
  })
})
