/** Browser-held key enrollment for the owned Host; the shared Web gate owns challenge exchange and renewal. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC, type AuthWebReply, type AuthWebRequest } from './ipc.ts'
import { generateDesktopDeviceKey, readDesktopBrowserDevice, writeDesktopBrowserDevice } from './desktop-browser-device.ts'

/**
 * Enroll a non-exportable key over private owned-child IPC, then reload into the shared Web gate.
 * @returns completion of persisted bootstrap; existing Hosts retain their normal enrollment flow.
 */
export async function bootstrapOwnedBrowser(): Promise<void> {
  const request = (value: AuthWebRequest): Promise<AuthWebReply> => ipcRenderer.invoke(DESKTOP_IPC.authWeb, value)
  const boot = await request({ kind: 'inspect' })
  if (boot.kind !== 'enroll') return
  const stored = await readDesktopBrowserDevice()
  // Web enrollment owns records without the desktop public key, including pending pairing.
  if (stored !== undefined && stored.publicKey === undefined) return
  const pair = stored?.publicKey === undefined ? await generateDesktopDeviceKey()
    : { privateKey: stored.privateKey, publicKey: stored.publicKey }
  const approved = await request({ kind: 'enroll', publicKey: pair.publicKey })
  if (approved.kind !== 'approved') throw new Error('Desktop enrollment was not approved.')
  await writeDesktopBrowserDevice({ kind: 'device', name: approved.name, ...pair, grantId: approved.grantId })
  await request({ kind: 'complete' })
}
