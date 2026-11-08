import { describe, expect, it } from 'vitest'
import { relativizeToCwd, workspaceTitleOf } from '../src/index.ts'

describe('workspace path display helpers', () => {
  it('reads the final path segment on both path styles', () => {
    expect(workspaceTitleOf('/work/project/')).toBe('project')
    expect(workspaceTitleOf('C:\\work\\project\\')).toBe('project')
    expect(workspaceTitleOf('/')).toBe('')
  })

  it.each([
    ['/work/report.txt', '/work', 'report.txt'],
    ['/work/reports/result.pdf', '/work/', 'reports/result.pdf'],
    ['/work-other/report.txt', '/work', '/work-other/report.txt'],
    ['/other/report.txt', '/work', '/other/report.txt'],
    ['report.txt', '/work', 'report.txt'],
    ['/work/report.txt', undefined, '/work/report.txt'],
    ['/work/report.txt', '', '/work/report.txt'],
    ['/report.txt', '/', 'report.txt'],
    [String.raw`C:\work\reports\result.pdf`, String.raw`C:\work`, String.raw`reports\result.pdf`],
    [String.raw`\\server\share\report.txt`, String.raw`\\server\share`, 'report.txt'],
  ])('displays %s relative to %s only within that workspace', (path, cwd, label) => {
    expect(relativizeToCwd(path, cwd)).toBe(label)
  })
})
