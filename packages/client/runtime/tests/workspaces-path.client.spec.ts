import { describe, expect, it } from 'vitest'
import { resolveWorkspacePath } from '../src/client/workspaces/path.ts'

describe('resolveWorkspacePath', () => {
  it('resolves relative paths without changing absolute paths', () => {
    expect(resolveWorkspacePath('/w', 'src/a.ts')).toBe('/w/src/a.ts')
    expect(resolveWorkspacePath('/w/', '/abs/a.ts')).toBe('/abs/a.ts')
    expect(resolveWorkspacePath(undefined, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('', 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('/w', 'C:\\x\\a.ts')).toBe('C:\\x\\a.ts')
    expect(resolveWorkspacePath('/w', '\\\\server\\share')).toBe('\\\\server\\share')
  })

  it('keeps Windows drive-root and directory joins fully qualified', () => {
    expect(resolveWorkspacePath('C:\\', 'src\\a.ts')).toBe('C:\\src\\a.ts')
    expect(resolveWorkspacePath('C:\\work\\', 'src\\a.ts')).toBe('C:\\work\\src\\a.ts')
    expect(resolveWorkspacePath('C:/work/', 'src/a.ts')).toBe('C:/work/src/a.ts')
  })
})
