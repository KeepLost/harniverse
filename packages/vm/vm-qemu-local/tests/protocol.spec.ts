import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, negotiateVersion, parseGuestMessage } from '../src/protocol.ts'

describe('vm-qemu-local protocol negotiation', () => {
  it('agrees when host and guest versions match exactly', () => {
    expect(negotiateVersion(PROTOCOL_VERSION, 1)).toEqual({ ok: true, version: 1 })
  })

  it('rejects a mismatch with both versions named', () => {
    expect(negotiateVersion(PROTOCOL_VERSION, 2)).toEqual({
      ok: false,
      reason: 'version-mismatch',
      hostV: 1,
      guestV: 2,
    })
  })
})

describe('vm-qemu-local guest message parsing', () => {
  it('parses a welcome with version, caps, and agent id', () => {
    expect(parseGuestMessage('{"t":"welcome","v":1,"caps":["ping"],"agent":"dsh-vm-guest-agent 0.1.0"}')).toEqual({
      t: 'welcome',
      v: 1,
      caps: ['ping'],
      agent: 'dsh-vm-guest-agent 0.1.0',
    })
  })

  it('drops a welcome whose caps are not strings', () => {
    expect(parseGuestMessage('{"t":"welcome","v":1,"caps":[7],"agent":"x"}')).toBeUndefined()
  })

  it('drops a welcome missing the agent id', () => {
    expect(parseGuestMessage('{"t":"welcome","v":1,"caps":[]}')).toBeUndefined()
  })

  it('parses a pong carrying the ping echo number', () => {
    expect(parseGuestMessage('{"t":"pong","n":42}')).toEqual({ t: 'pong', n: 42 })
  })

  it('drops a pong whose echo number is not a number', () => {
    expect(parseGuestMessage('{"t":"pong","n":"42"}')).toBeUndefined()
  })

  it('parses a version rejection with the guest range', () => {
    expect(parseGuestMessage('{"t":"error","code":"version","minV":1,"maxV":1,"message":"mismatch"}')).toEqual({
      t: 'error',
      code: 'version',
      minV: 1,
      maxV: 1,
      message: 'mismatch',
    })
  })

  it('parses an unknown-message rejection without optional fields', () => {
    expect(parseGuestMessage('{"t":"error","code":"unknown-message"}')).toEqual({ t: 'error', code: 'unknown-message' })
  })

  it('drops an error with an unknown code', () => {
    expect(parseGuestMessage('{"t":"error","code":"mystery"}')).toBeUndefined()
  })

  it('drops malformed JSON, non-objects, and unknown message types', () => {
    expect(parseGuestMessage('{nope')).toBeUndefined()
    expect(parseGuestMessage('7')).toBeUndefined()
    expect(parseGuestMessage('{"t":"goodbye"}')).toBeUndefined()
  })
})
