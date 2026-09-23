/** Renderer-side device key persistence shared with the Web authentication gate's store. */

export interface DesktopBrowserDevice {
  kind: 'device'
  name: string
  privateKey: CryptoKey
  publicKey?: string
  grantId?: string
}

function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Generate a non-exportable P-256 key and return its base64url SPKI public key. */
export async function generateDesktopDeviceKey(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { privateKey: pair.privateKey, publicKey: base64url(await crypto.subtle.exportKey('spki', pair.publicKey)) }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-authentication', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('devices')) request.result.createObjectStore('devices')
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB unavailable')) }
  })
}

/** Read the Web gate's existing key before requesting owned-Host approval; never rotate it implicitly. */
export async function readDesktopBrowserDevice(): Promise<DesktopBrowserDevice | undefined> {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('devices').objectStore('devices').get('primary')
      request.onsuccess = () => { resolve(request.result as DesktopBrowserDevice | undefined) }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB read failed')) }
    })
  } finally { database.close() }
}

/** Commit the approved private/public key and grant together before the Web gate reloads. */
export async function writeDesktopBrowserDevice(device: DesktopBrowserDevice): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('devices', 'readwrite')
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB write aborted')) }
      transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB write failed')) }
      transaction.objectStore('devices').put(device, 'primary')
    })
  } finally { database.close() }
}
