import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseHostCommand, scrubHostEnvironment } from '../src/protocol.ts'

describe('private Host control', () => {
  it('accepts only an exact P-256 shell enrollment and rejects public approval ids', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const command = { type: 'enroll', requestId: 1, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
    expect(parseHostCommand(command)).toEqual(command)
    expect(parseHostCommand({ ...command, enrollmentId: 'another-browser' })).toBeUndefined()
    expect(parseHostCommand({ ...command, publicKey: 'not-a-key' })).toBeUndefined()
    expect(parseHostCommand({ type: 'shutdown', pid: 123 })).toBeUndefined()
    expect(parseHostCommand({ type: 'update-tasks', requestId: -1, action: 'lock' })).toBeUndefined()
  })

  it('scrubs credentials and execution overrides before any profile plugin starts', () => {
    expect(scrubHostEnvironment({ PATH: '/bin', HOME: '/home/me', API_KEY: 'secret', SecretValue: 'secret',
      NODE_OPTIONS: '--require=/tmp/inject', NODE_PATH: '/tmp', DSH_HOME: '/other', ELECTRON_RUN_AS_NODE: '1' }, '/owned'))
      .toEqual({ PATH: '/bin', HOME: '/home/me', DSH_HOME: '/owned' })
  })
})
