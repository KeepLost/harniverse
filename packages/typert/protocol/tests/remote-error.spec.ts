/**
 * RemoteError structural contract: the class carries the wire marker so a
 * failure crossing a process boundary stays recognizable without sharing the
 * class instance, and remoteErrorOf admits exactly the marker+string-code
 * shape (casting it back to the failure record) while rejecting everything
 * else.
 */

import { describe, expect, it } from 'vitest'
import { RemoteError, remoteErrorOf } from '../src/index.ts'

describe('RemoteError', () => {
  it('carries the structural marker, its code, and an options cause', () => {
    const cause = new Error('root cause')
    const error = new RemoteError('terminal-unavailable', 'Terminal is closing or unavailable', { reason: 'fixture' }, { cause })
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RemoteError')
    expect(error.message).toBe('Terminal is closing or unavailable')
    expect(error.isDSHRemoteError).toBe(true)
    expect(error.cause).toBe(cause)
    expect(remoteErrorOf(error)).toBe(error)
  })

  it('recognizes a structurally identical failure from another process', () => {
    const alien: unknown = JSON.parse(JSON.stringify({
      isDSHRemoteError: true,
      code: 'terminal-limit-reached',
      message: 'Session terminal limit reached',
      details: { limit: 8 },
    }))
    const remote = remoteErrorOf(alien)
    expect(remote).toMatchObject({
      code: 'terminal-limit-reached',
      message: 'Session terminal limit reached',
      details: { limit: 8 },
    })
  })

  it('rejects values without the marker, a true marker without a string code, and non-objects', () => {
    expect(remoteErrorOf(undefined)).toBeUndefined()
    expect(remoteErrorOf(null)).toBeUndefined()
    expect(remoteErrorOf('terminal-unavailable')).toBeUndefined()
    expect(remoteErrorOf(new Error('plain error'))).toBeUndefined()
    expect(remoteErrorOf({ code: 'terminal-unavailable', message: 'm', details: {} })).toBeUndefined()
    expect(remoteErrorOf({ isDSHRemoteError: false, code: 'terminal-unavailable', message: 'm', details: {} })).toBeUndefined()
    expect(remoteErrorOf({ isDSHRemoteError: true, code: 8, message: 'm', details: {} })).toBeUndefined()
  })
})
