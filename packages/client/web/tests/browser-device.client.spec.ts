// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBrowserDevice,
  generateBrowserDeviceKey,
  readBrowserDevice,
  signBrowserChallenge,
  writeBrowserDevice,
} from '../src/browser-device.ts'

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  await clearBrowserDevice()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser device key storage', () => {
  it('generates a non-exportable P-256 private key and raw P1363 proof', async () => {
    const key = await generateBrowserDeviceKey()
    expect(key.privateKey.extractable).toBe(false)
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    await expect(signBrowserChallenge(key.privateKey, '{"challenge":true}'))
      .resolves.toMatch(/^[A-Za-z0-9_-]{86}$/)
  })

  it('persists only trusted-device keys and removes unusable records', async () => {
    const key = await generateBrowserDeviceKey()
    await writeBrowserDevice({
      name: 'tablet',
      kind: 'device',
      privateKey: key.privateKey,
      grantId: 'grant-id',
    })

    await expect(readBrowserDevice()).resolves.toMatchObject({
      name: 'tablet',
      kind: 'device',
      grantId: 'grant-id',
      privateKey: { extractable: false },
    })
    await clearBrowserDevice()
    await expect(readBrowserDevice()).resolves.toBeUndefined()
  })
})
