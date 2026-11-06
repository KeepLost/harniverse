import { describe, expect, it } from 'vitest'
import { HOST_CAPS, PROTOCOL_VERSION, isOpReplyFor, negotiateVersion, parseGuestMessage } from '../src/protocol.ts'

describe('vm-qemu-local protocol negotiation', () => {
  it('agrees when host and guest versions match exactly', () => {
    expect(negotiateVersion(PROTOCOL_VERSION, PROTOCOL_VERSION)).toEqual({ ok: true, version: PROTOCOL_VERSION })
  })

  it('rejects a mismatch with both versions named', () => {
    expect(negotiateVersion(PROTOCOL_VERSION, PROTOCOL_VERSION + 1)).toEqual({
      ok: false,
      reason: 'version-mismatch',
      hostV: PROTOCOL_VERSION,
      guestV: PROTOCOL_VERSION + 1,
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


  it('matches op replies by id and tag', () => {
    expect(isOpReplyFor('{"t":"fs.ok","id":1}', 1, ['fs.ok', 'fs.err'])).toBe(true)
    expect(isOpReplyFor('not json', 1, ['fs.ok'])).toBe(false)
    expect(isOpReplyFor('{"t":"pong","n":1}', 1, ['fs.ok'])).toBe(false)
    expect(isOpReplyFor('{"t":"fs.ok","id":2}', 1, ['fs.ok'])).toBe(false)
    expect(isOpReplyFor('{"t":"fs.ok","id":1}', 1, ['fs.err'])).toBe(false)
  })

  it('rejects op messages with malformed optional payloads', () => {
    expect(parseGuestMessage('{"t":"exec.acked"}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok"}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"entries":[5]}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"st":5}')).toEqual({ t: 'fs.ok', id: 1 })
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"st":{"kind":"sock","size":1,"mode":1,"mtimeMs":1}}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"st":{"kind":"file","size":"x","mode":1,"mtimeMs":1}}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"st":{"kind":"file","size":1,"mode":"x","mtimeMs":1}}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.ok","id":1,"st":{"kind":"file","size":1,"mode":1,"mtimeMs":"x"}}')).toBeUndefined()
  })

  it('parses guest egress frames and rejects malformed ones', () => {
    expect(parseGuestMessage('{"t":"egress.open","id":1,"host":"api.example","port":443,"origin":"vm-exec-1"}'))
      .toEqual({ t: 'egress.open', id: 1, host: 'api.example', port: 443, origin: 'vm-exec-1' })
    expect(parseGuestMessage('{"t":"egress.open","id":2,"host":"bare.example","port":80}'))
      .toEqual({ t: 'egress.open', id: 2, host: 'bare.example', port: 80 })
    expect(parseGuestMessage('{"t":"egress.open","id":3,"host":"x","port":"443"}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"egress.write","id":1,"d":"cGluZw=="}')).toEqual({ t: 'egress.write', id: 1, d: 'cGluZw==' })
    expect(parseGuestMessage('{"t":"egress.write","id":1}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"egress.close","id":1}')).toEqual({ t: 'egress.close', id: 1 })
    expect(isOpReplyFor('{"t":"egress.close","id":1}', 1, ['egress.close'])).toBe(true)
  })

  it('parses workspace completions and rejects malformed ones', () => {
    expect(parseGuestMessage('{"t":"workspace.ok","id":3,"bytes":4096}')).toEqual({ t: 'workspace.ok', id: 3, bytes: 4096 })
    expect(parseGuestMessage('{"t":"workspace.err","id":4,"message":"busy"}')).toEqual({ t: 'workspace.err', id: 4, message: 'busy' })
    expect(parseGuestMessage('{"t":"workspace.ok","id":3,"bytes":"4096"}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"workspace.err","id":4}')).toBeUndefined()
    expect(isOpReplyFor('{"t":"workspace.ok","id":3,"bytes":1}', 3, ['workspace.ok', 'workspace.err'])).toBe(true)
  })

  it('announces the workspace capability in the host caps', () => {
    expect(HOST_CAPS).toContain('workspace')
    expect(PROTOCOL_VERSION).toBe(3)
  })
})
