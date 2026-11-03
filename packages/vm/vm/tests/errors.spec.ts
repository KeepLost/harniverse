/**
 * Error-taxonomy tests: each class carries its contract facts and the name
 * consumers classify on.
 */

import { describe, expect, it } from 'vitest'
import { ExecOptionsError, ExecOutputLimitError, ExecStartError, GuestFsError } from '../src/errors.ts'

describe('vm error taxonomy', () => {
  it('ExecStartError carries the refused exec id and guest message', () => {
    const error = new ExecStartError(7, 'no pty')
    expect(error.name).toBe('ExecStartError')
    expect(error.execId).toBe(7)
    expect(error.guestMessage).toBe('no pty')
    expect(error.message).toBe('guest rejected exec 7: no pty')
  })

  it('ExecOptionsError passes the validation message through', () => {
    const error = new ExecOptionsError('argv must be non-empty')
    expect(error.name).toBe('ExecOptionsError')
    expect(error.message).toBe('argv must be non-empty')
  })

  it('ExecOutputLimitError carries the exceeded bound', () => {
    const error = new ExecOutputLimitError(1024)
    expect(error.name).toBe('ExecOutputLimitError')
    expect(error.limitBytes).toBe(1024)
    expect(error.message).toBe('exec output exceeded 1024 bytes')
  })

  it('GuestFsError carries the errno code pair', () => {
    const error = new GuestFsError('ENOENT', 2, 'no such file')
    expect(error.name).toBe('GuestFsError')
    expect(error.code).toBe('ENOENT')
    expect(error.errno).toBe(2)
    expect(error.message).toBe('guest fs error ENOENT (errno 2): no such file')
  })
})
