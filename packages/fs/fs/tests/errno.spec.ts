import { describe, expect, it } from 'vitest'
import { FS_ERROR_CODES, FsError, fsErrorFromErrno } from '../src/index.ts'

function errnoError(code: string, message = `${code}: boom`): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('fsErrorFromErrno', () => {
  it.each([
    ['ENOENT', 'FS_NOT_FOUND', 'not found'],
    ['ENOTDIR', 'FS_NOT_FOUND', 'not found'],
    ['EACCES', 'FS_PERMISSION_DENIED', 'permission denied'],
    ['EPERM', 'FS_PERMISSION_DENIED', 'permission denied'],
    ['EISDIR', 'FS_NOT_REGULAR_FILE', 'not a regular file'],
    ['EIO', 'FS_IO_ERROR', 'EIO: boom'],
  ])('classifies %s as %s', (code, expected, detail) => {
    const cause = errnoError(code)
    const classified = fsErrorFromErrno('read', 'a/b.txt', cause)
    expect(classified).toBeInstanceOf(FsError)
    const failure = classified as FsError
    expect(failure.code).toBe(expected)
    expect(failure.message).toBe(`cannot read "a/b.txt": ${detail}`)
    expect(failure.cause).toBe(cause)
    expect(FS_ERROR_CODES).toContain(failure.code)
  })

  it('returns an FsError unchanged', () => {
    const typed = new FsError('typed', 'FS_TOO_LARGE')
    expect(fsErrorFromErrno('read', 'a', typed)).toBe(typed)
  })

  it('returns a value without a string errno code unchanged', () => {
    const noCode = new Error('no code')
    expect(fsErrorFromErrno('read', 'a', noCode)).toBe(noCode)
    expect(fsErrorFromErrno('read', 'a', 'not an error')).toBe('not an error')
  })
})
