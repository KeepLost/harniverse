// Pure helpers of the desktop drop/paste intake: the shell bridge read, the
// cwd relativization, the workspace title, and the @path mention grammar.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatFileMention, hostPathBridge, relativizeToCwd, workspaceTitleOf,
} from '../src/client/input/file-paths.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('host path bridge', () => {
  it('reads the shell-installed bridge and reports none on a served page', () => {
    expect(hostPathBridge()).toBeUndefined()
    const pathFor = vi.fn((file: File) => `/Users/me/${file.name}`)
    vi.stubGlobal('harniverseHostPaths', { pathFor })
    const bridge = hostPathBridge()
    expect(bridge?.pathFor(new File([], 'notes.md'))).toBe('/Users/me/notes.md')
  })
})

describe('relativizeToCwd', () => {
  it('strips the workspace root in either separator spelling and keeps foreign paths', () => {
    expect(relativizeToCwd('/proj/src/a.ts', '/proj')).toBe('src/a.ts')
    expect(relativizeToCwd('/proj\\src\\a.ts', '/proj')).toBe('src\\a.ts')
    // Trailing separators on the root normalize away.
    expect(relativizeToCwd('/proj/b.ts', '/proj/')).toBe('b.ts')
    // The root itself and outside paths stay verbatim.
    expect(relativizeToCwd('/proj', '/proj')).toBe('/proj')
    expect(relativizeToCwd('/elsewhere/a.ts', '/proj')).toBe('/elsewhere/a.ts')
    // Absent or empty cwd keeps the path unchanged.
    expect(relativizeToCwd('/proj/a.ts', undefined)).toBe('/proj/a.ts')
    expect(relativizeToCwd('/proj/a.ts', '')).toBe('/proj/a.ts')
  })
})

describe('workspaceTitleOf', () => {
  it('reads the final non-empty segment across separator spellings', () => {
    expect(workspaceTitleOf('/Users/me/notes.md')).toBe('notes.md')
    expect(workspaceTitleOf('/Users/me/my project/')).toBe('my project')
    expect(workspaceTitleOf('C:\\dev\\repo')).toBe('repo')
    expect(workspaceTitleOf('/')).toBe('')
  })
})

describe('formatFileMention', () => {
  it('quotes only whitespace paths and closes the quote over directory tails', () => {
    expect(formatFileMention('src/a.ts')).toBe('@src/a.ts')
    expect(formatFileMention('my folder/')).toBe('@"my folder/"')
    expect(formatFileMention('a b/c d.ts')).toBe('@"a b/c d.ts"')
  })

  it('refuses control characters and embedded quotes', () => {
    expect(formatFileMention('bad"name')).toBeUndefined()
    expect(formatFileMention('bad\nname')).toBeUndefined()
    expect(formatFileMention('bad\u007fname')).toBeUndefined()
  })
})
