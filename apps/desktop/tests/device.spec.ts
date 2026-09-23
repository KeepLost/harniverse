// @vitest-environment jsdom
import '../../../packages/client/web/node_modules/fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateDesktopDeviceKey, readDesktopBrowserDevice, writeDesktopBrowserDevice } from '../src/desktop-browser-device.ts'

beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals() })

describe('desktop browser device persistence', () => {
  it('round-trips the non-exportable key, public key, and grant as one record', async () => {
    const key = await generateDesktopDeviceKey()
    await writeDesktopBrowserDevice({ kind: 'device', name: 'Desktop', ...key, grantId: 'grant-1' })
    await expect(readDesktopBrowserDevice()).resolves.toMatchObject({
      kind: 'device', name: 'Desktop', publicKey: key.publicKey, grantId: 'grant-1',
      privateKey: { extractable: false },
    })
  })
})
